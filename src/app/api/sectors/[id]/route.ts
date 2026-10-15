import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

interface SectorPatch {
  name?: unknown;
  color?: unknown;
  is_default?: unknown;
  is_active?: unknown;
  member_ids?: unknown;
  primary_member_ids?: unknown;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const body = (await request.json()) as SectorPatch;
    const { data: existing } = await ctx.supabase
      .from('sectors')
      .select('id, is_default')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: 'Setor não encontrado' }, { status: 404 });

    const updates: Record<string, unknown> = {};
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (name.length < 2 || name.length > 60) {
        return NextResponse.json({ error: 'Informe um nome entre 2 e 60 caracteres' }, { status: 400 });
      }
      updates.name = name;
    }
    if (typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color)) updates.color = body.color;
    if (typeof body.is_active === 'boolean') updates.is_active = body.is_active;
    if (typeof body.is_default === 'boolean') {
      updates.is_default = body.is_default;
      if (body.is_default) {
        updates.is_active = true;
        const { error } = await ctx.supabase
          .from('sectors')
          .update({ is_default: false })
          .eq('account_id', ctx.accountId)
          .neq('id', id);
        if (error) throw error;
      }
    }
    if (updates.is_active === false && (updates.is_default === true || existing.is_default)) {
      return NextResponse.json({ error: 'Defina outro setor padrão antes de desativar este' }, { status: 400 });
    }

    if (Object.keys(updates).length) {
      const { error } = await ctx.supabase
        .from('sectors')
        .update(updates)
        .eq('id', id)
        .eq('account_id', ctx.accountId);
      if (error) {
        return NextResponse.json(
          { error: error.code === '23505' ? 'Já existe um setor com esse nome' : 'Falha ao atualizar setor' },
          { status: error.code === '23505' ? 409 : 500 },
        );
      }
    }

    if (Array.isArray(body.member_ids)) {
      const memberIds = [...new Set(body.member_ids.filter((value): value is string => typeof value === 'string'))];
      const primaryIds = new Set(
        Array.isArray(body.primary_member_ids)
          ? body.primary_member_ids.filter((value): value is string => typeof value === 'string')
          : [],
      );
      const { data: validMembers } = memberIds.length
        ? await ctx.supabase
            .from('profiles')
            .select('user_id')
            .eq('account_id', ctx.accountId)
            .in('user_id', memberIds)
        : { data: [] };
      if ((validMembers?.length ?? 0) !== memberIds.length) {
        return NextResponse.json({ error: 'Um ou mais usuários não pertencem à conta' }, { status: 400 });
      }

      for (const userId of memberIds) {
        if (primaryIds.has(userId)) {
          await ctx.supabase
            .from('sector_members')
            .update({ is_primary: false })
            .eq('account_id', ctx.accountId)
            .eq('user_id', userId)
            .eq('is_primary', true);
        }
      }
      const { error: deleteError } = await ctx.supabase
        .from('sector_members')
        .delete()
        .eq('sector_id', id)
        .eq('account_id', ctx.accountId);
      if (deleteError) throw deleteError;
      if (memberIds.length) {
        const { error: insertError } = await ctx.supabase.from('sector_members').insert(
          memberIds.map((userId) => ({
            sector_id: id,
            account_id: ctx.accountId,
            user_id: userId,
            is_primary: primaryIds.has(userId),
          })),
        );
        if (insertError) throw insertError;
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[PATCH /api/sectors/:id] error:', error);
    return toErrorResponse(error);
  }
}
