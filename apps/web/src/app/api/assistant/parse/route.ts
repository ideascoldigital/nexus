/**
 * POST /api/assistant/parse
 * 
 * Parse agent/skill configuration from assistant response
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseAgentConfig, parseSkillConfig } from '@/services/agents-generator';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, response } = body;

    if (!type || !['agent', 'skill'].includes(type)) {
      return NextResponse.json(
        { error: 'Invalid type. Must be: agent or skill' },
        { status: 400 }
      );
    }

    if (!response || typeof response !== 'string') {
      return NextResponse.json(
        { error: 'Response is required' },
        { status: 400 }
      );
    }

    let config: unknown = null;

    if (type === 'agent') {
      config = parseAgentConfig(response);
    } else {
      config = parseSkillConfig(response);
    }

    if (!config) {
      return NextResponse.json(
        { error: 'No valid configuration found in response' },
        { status: 400 }
      );
    }

    return NextResponse.json({ config });
  } catch (error) {
    console.error('Parse config error:', error);
    return NextResponse.json(
      {
        error: 'Failed to parse configuration',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
