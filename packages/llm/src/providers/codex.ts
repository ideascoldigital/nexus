/**
 * Codex API Integration
 * 
 * Handles API key authentication for Codex API
 */

export interface CodexConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface CodexUserInfo {
  id: string;
  email: string;
  name?: string;
  avatar_url?: string;
}

export interface CodexModel {
  id: string;
  name: string;
  description?: string;
}

import { getConfig } from "@nexux/config";

const DEFAULT_CODEX_BASE_URL = getConfig().integrations.codexApiUrl;

/**
 * Fetch user information from Codex API
 */
export async function fetchCodexUserInfo(apiKey: string, baseUrl?: string): Promise<CodexUserInfo> {
  const url = `${baseUrl || DEFAULT_CODEX_BASE_URL}/user`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch user info: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * List available Codex models
 */
export async function fetchCodexModels(apiKey: string, baseUrl?: string): Promise<CodexModel[]> {
  const url = `${baseUrl || DEFAULT_CODEX_BASE_URL}/models`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch models: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.models || data;
}

/**
 * Test API key validity
 */
export async function testCodexApiKey(apiKey: string, baseUrl?: string): Promise<boolean> {
  try {
    await fetchCodexUserInfo(apiKey, baseUrl);
    return true;
  } catch (error) {
    console.error('Codex API key test failed:', error);
    return false;
  }
}

/**
 * Make a completion request to Codex API
 * Example usage for testing or future features
 */
export async function createCodexCompletion(
  apiKey: string,
  prompt: string,
  options?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    baseUrl?: string;
  }
) {
  const url = `${options?.baseUrl || DEFAULT_CODEX_BASE_URL}/completions`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      model: options?.model || 'codex-default',
      prompt,
      max_tokens: options?.maxTokens || 100,
      temperature: options?.temperature || 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Completion request failed: ${response.status} - ${error}`);
  }

  return response.json();
}
