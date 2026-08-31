/**
 * POST /api/settings/validate
 * 
 * Validate an API key before saving
 */

import { NextRequest, NextResponse } from 'next/server';
import { testCodexApiKey } from "@nexux/llm";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { provider, key, value } = body;

    if (!provider || !key || !value) {
      return NextResponse.json(
        { error: 'Provider, key, and value are required' },
        { status: 400 }
      );
    }

    let isValid = false;
    let errorMessage = '';

    // Validate based on provider
    switch (key) {
      case 'codex_api_key':
        try {
          isValid = await testCodexApiKey(value);
          if (!isValid) {
            errorMessage = 'Invalid Codex API key';
          }
        } catch (error) {
          errorMessage =
            error instanceof Error && error.message
              ? error.message
              : 'Failed to validate Codex API key';
        }
        break;

      case 'anthropic_api_key':
        // Add Anthropic validation if needed
        isValid = value.startsWith('sk-ant-');
        if (!isValid) {
          errorMessage = 'Invalid Anthropic API key format';
        }
        break;

      case 'openai_api_key':
        // Add OpenAI validation if needed
        isValid = value.startsWith('sk-');
        if (!isValid) {
          errorMessage = 'Invalid OpenAI API key format';
        }
        break;

      case 'xai_api_key':
        // Add xAI validation if needed
        isValid = value.startsWith('xai-');
        if (!isValid) {
          errorMessage = 'Invalid xAI API key format';
        }
        break;

      case 'ollama_url':
      case 'lmstudio_url':
        // Simple URL validation
        try {
          new URL(value);
          isValid = true;
        } catch {
          errorMessage = 'Invalid URL format';
        }
        break;

      default:
        isValid = true; // Allow unknown providers
    }

    if (!isValid) {
      return NextResponse.json(
        { valid: false, error: errorMessage },
        { status: 400 }
      );
    }

    return NextResponse.json({ valid: true });
  } catch (error) {
    console.error('Validation error:', error);
    return NextResponse.json(
      {
        valid: false,
        error:
          error instanceof Error && error.message
            ? error.message
            : 'Validation failed',
      },
      { status: 500 }
    );
  }
}
