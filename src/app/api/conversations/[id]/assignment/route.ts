import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const body = (await request.json()) as {
      sector_id?: unknown;
      assigned_agent_id?: unknown;
      note?: unknown;
    };
    const sectorId = typeof body.sector_id === 'string' ? body.sector_id : null;
    const agentId = typeof body.assigned_agent_id === 'string' ? body.assigned_agent_id : null;
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;

    const { data, error } = await ctx.supabase.rpc('transfer_conversation', {
      p_conversation_id: id,
      p_sector_id: sectorId,
      p_agent_id: agentId,
      p_note: note,
    });
    if (error) {
      console.error('[PATCH assignment] rpc error:', error);
      const status = error.code === 'P0002' ? 404 : error.code === '42501' ? 403 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ conversation: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await params;
    const { data, error } = await ctx.supabase
      .from('conversation_transfers')
      .select('id, conversation_id, from_sector_id, to_sector_id, from_agent_id, to_agent_id, transferred_by_user_id, note, created_at')
      .eq('account_id', ctx.accountId)
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw error;
    return NextResponse.json({ transfers: data ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}
