/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PartListUnion } from '@google/genai';
import type { Config } from '@google/gemini-cli-core';
import {
  debugLogger,
  getErrorMessage,
  isNodeError,
  unescapePath,
} from '@google/gemini-cli-core';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';

interface HandleAtCommandParams {
  query: string;
  config: Config;
  addItem: UseHistoryManagerReturn['addItem'];
  onDebugMessage: (message: string) => void;
  messageId: number;
  signal: AbortSignal;
}

interface HandleAtCommandResult {
  processedQuery: PartListUnion | null;
  shouldProceed: boolean;
}

interface AtCommandPart {
  type: 'text' | 'atPath';
  content: string;
}

/**
 * Parses a query string to find all '@<path>' commands and text segments.
 * Handles \ escaped spaces within paths.
 */
function parseAllAtCommands(query: string): AtCommandPart[] {
  const parts: AtCommandPart[] = [];
  let currentIndex = 0;

  while (currentIndex < query.length) {
    let atIndex = -1;
    let nextSearchIndex = currentIndex;
    // Find next unescaped '@'
    while (nextSearchIndex < query.length) {
      if (
        query[nextSearchIndex] === '@' &&
        (nextSearchIndex === 0 || query[nextSearchIndex - 1] !== '\\')
      ) {
        atIndex = nextSearchIndex;
        break;
      }
      nextSearchIndex++;
    }

    if (atIndex === -1) {
      // No more @
      if (currentIndex < query.length) {
        parts.push({ type: 'text', content: query.substring(currentIndex) });
      }
      break;
    }

    // Add text before @
    if (atIndex > currentIndex) {
      parts.push({
        type: 'text',
        content: query.substring(currentIndex, atIndex),
      });
    }

    // Parse @path
    let pathEndIndex = atIndex + 1;
    let inEscape = false;
    while (pathEndIndex < query.length) {
      const char = query[pathEndIndex];
      if (inEscape) {
        inEscape = false;
      } else if (char === '\\') {
        inEscape = true;
      } else if (/[,\s;!?()[\]{}]/.test(char)) {
        // Path ends at first whitespace or punctuation not escaped
        break;
      } else if (char === '.') {
        // For . we need to be more careful - only terminate if followed by whitespace or end of string
        // This allows file extensions like .txt, .js but terminates at sentence endings like "file.txt. Next sentence"
        const nextChar =
          pathEndIndex + 1 < query.length ? query[pathEndIndex + 1] : '';
        if (nextChar === '' || /\s/.test(nextChar)) {
          break;
        }
      }
      pathEndIndex++;
    }
    const rawAtPath = query.substring(atIndex, pathEndIndex);
    // unescapePath expects the @ symbol to be present, and will handle it.
    const atPath = unescapePath(rawAtPath);
    parts.push({ type: 'atPath', content: atPath });
    currentIndex = pathEndIndex;
  }
  // Filter out empty text parts that might result from consecutive @paths or leading/trailing spaces
  return parts.filter(
    (part) => !(part.type === 'text' && part.content.trim() === ''),
  );
}

/**
 * Processes user input potentially containing one or more '@<path>' commands.
 * Replaces the '@<path>' with the absolute path of the referenced file or directory.
 *
 * @returns An object indicating whether the main hook should proceed with an
 *          LLM call and the processed query parts.
 */
export async function handleAtCommand({
  query,
  config,
  addItem,
  onDebugMessage,
  messageId: userMessageTimestamp,
  signal,
}: HandleAtCommandParams): Promise<HandleAtCommandResult> {
  const commandParts = parseAllAtCommands(query);
  const atPathCommandParts = commandParts.filter(
    (part) => part.type === 'atPath',
  );

  if (atPathCommandParts.length === 0) {
    return { processedQuery: [{ text: query }], shouldProceed: true };
  }

  // Get centralized file discovery service
  const fileDiscovery = config.getFileService();

  const respectFileIgnore = config.getFileFilteringOptions();

  const atPathToResolvedPathMap = new Map<string, string>();
  const ignoredByReason: Record<string, string[]> = {
    git: [],
    gemini: [],
    both: [],
  };

  const toolRegistry = config.getToolRegistry();
  const globTool = toolRegistry.getTool('glob');

  for (const atPathPart of atPathCommandParts) {
    const originalAtPath = atPathPart.content; // e.g., "@file.txt" or "@"

    if (originalAtPath === '@') {
      onDebugMessage(
        'Lone @ detected, will be treated as text in the modified query.',
      );
      continue;
    }

    const pathName = originalAtPath.substring(1);
    if (!pathName) {
      addItem(
        {
          type: 'error',
          text: `Error: Invalid @ command '${originalAtPath}'. No path specified.`,
        },
        userMessageTimestamp,
      );
      return { processedQuery: null, shouldProceed: false };
    }

    // Check if path should be ignored based on filtering options
    const workspaceContext = config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(pathName)) {
      onDebugMessage(
        `Path ${pathName} is not in the workspace and will be skipped.`,
      );
      continue;
    }

    const gitIgnored =
      respectFileIgnore.respectGitIgnore &&
      fileDiscovery.shouldIgnoreFile(pathName, {
        respectGitIgnore: true,
        respectGeminiIgnore: false,
      });
    const geminiIgnored =
      respectFileIgnore.respectGeminiIgnore &&
      fileDiscovery.shouldIgnoreFile(pathName, {
        respectGitIgnore: false,
        respectGeminiIgnore: true,
      });

    if (gitIgnored || geminiIgnored) {
      const reason =
        gitIgnored && geminiIgnored ? 'both' : gitIgnored ? 'git' : 'gemini';
      ignoredByReason[reason].push(pathName);
      const reasonText =
        reason === 'both'
          ? 'ignored by both git and gemini'
          : reason === 'git'
            ? 'git-ignored'
            : 'gemini-ignored';
      onDebugMessage(`Path ${pathName} is ${reasonText} and will be skipped.`);
      continue;
    }

    for (const dir of config.getWorkspaceContext().getDirectories()) {
      let resolvedAbsolutePath: string | undefined;
      let resolvedSuccessfully = false;
      try {
        const absolutePath = path.resolve(dir, pathName);
        await fs.stat(absolutePath);
        // It exists.
        resolvedAbsolutePath = absolutePath;
        onDebugMessage(`Path ${pathName} resolved to: ${absolutePath}`);
        resolvedSuccessfully = true;
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          if (config.getEnableRecursiveFileSearch() && globTool) {
            onDebugMessage(
              `Path ${pathName} not found directly, attempting glob search.`,
            );
            try {
              const globResult = await globTool.buildAndExecute(
                {
                  pattern: `**/*${pathName}*`,
                  path: dir,
                },
                signal,
              );
              if (
                globResult.llmContent &&
                typeof globResult.llmContent === 'string' &&
                !globResult.llmContent.startsWith('No files found') &&
                !globResult.llmContent.startsWith('Error:')
              ) {
                const lines = globResult.llmContent.split('\n');
                if (lines.length > 1 && lines[1]) {
                  const firstMatchAbsolute = lines[1].trim();
                  resolvedAbsolutePath = firstMatchAbsolute;
                  onDebugMessage(
                    `Glob search for ${pathName} found ${firstMatchAbsolute}`,
                  );
                  resolvedSuccessfully = true;
                } else {
                  onDebugMessage(
                    `Glob search for '**/*${pathName}*' did not return a usable path. Path ${pathName} will be skipped.`,
                  );
                }
              } else {
                onDebugMessage(
                  `Glob search for '**/*${pathName}*' found no files or an error. Path ${pathName} will be skipped.`,
                );
              }
            } catch (globError) {
              console.error(
                `Error during glob search for ${pathName}: ${getErrorMessage(globError)}`,
              );
              onDebugMessage(
                `Error during glob search for ${pathName}. Path ${pathName} will be skipped.`,
              );
            }
          } else {
            onDebugMessage(
              `Glob tool not found. Path ${pathName} will be skipped.`,
            );
          }
        } else {
          console.error(
            `Error stating path ${pathName}: ${getErrorMessage(error)}`,
          );
          onDebugMessage(
            `Error stating path ${pathName}. Path ${pathName} will be skipped.`,
          );
        }
      }
      if (resolvedSuccessfully && resolvedAbsolutePath) {
        atPathToResolvedPathMap.set(originalAtPath, resolvedAbsolutePath);
        break;
      }
    }
  }

  // Construct the initial part of the query for the LLM
  let initialQueryText = '';
  for (let i = 0; i < commandParts.length; i++) {
    const part = commandParts[i];
    if (part.type === 'text') {
      initialQueryText += part.content;
    } else {
      // type === 'atPath'
      const resolvedPath = atPathToResolvedPathMap.get(part.content);
      if (
        i > 0 &&
        initialQueryText.length > 0 &&
        !initialQueryText.endsWith(' ')
      ) {
        // Add space if previous part was text and didn't end with space, or if previous was @path
        const prevPart = commandParts[i - 1];
        if (
          prevPart.type === 'text' ||
          (prevPart.type === 'atPath' &&
            atPathToResolvedPathMap.has(prevPart.content))
        ) {
          initialQueryText += ' ';
        }
      }
      if (resolvedPath) {
        initialQueryText += resolvedPath;
      } else {
        // If not resolved, add the original @-string back
        if (
          i > 0 &&
          initialQueryText.length > 0 &&
          !initialQueryText.endsWith(' ') &&
          !part.content.startsWith(' ')
        ) {
          initialQueryText += ' ';
        }
        initialQueryText += part.content;
      }
    }
  }
  initialQueryText = initialQueryText.trim();

  // Inform user about ignored paths
  const totalIgnored =
    ignoredByReason['git'].length +
    ignoredByReason['gemini'].length +
    ignoredByReason['both'].length;

  if (totalIgnored > 0) {
    const messages = [];
    if (ignoredByReason['git'].length) {
      messages.push(`Git-ignored: ${ignoredByReason['git'].join(', ')}`);
    }
    if (ignoredByReason['gemini'].length) {
      messages.push(`Gemini-ignored: ${ignoredByReason['gemini'].join(', ')}`);
    }
    if (ignoredByReason['both'].length) {
      messages.push(`Ignored by both: ${ignoredByReason['both'].join(', ')}`);
    }

    const message = `Ignored ${totalIgnored} files:\n${messages.join('\n')}`;
    debugLogger.log(message);
    onDebugMessage(message);
  }

  return {
    processedQuery: [{ text: initialQueryText || query }],
    shouldProceed: true,
  };
}
