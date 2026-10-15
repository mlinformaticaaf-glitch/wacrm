import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';

interface SectorInput {
  name?: unknown;
  color?: unknown;
  is_default?: unknown;
  member_ids?: unknown;
  primary_member_ids?: unknown;
}

function parseInput(body: SectorInput) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const color = typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color)
    ? body.color
    : '#25D366';
  const memberIds = Array.isArray(body.member_ids)
    ? [...new Set(body.member_ids.filter((id): id is string => typeof id === 'string'))]
    : [];
  const primaryIds = Array.isArray(body.primary_member_ids)
    ? [...new Set(body.primary_member_ids.filter((id): id is string => typeof id === 'string'))]
    : [];
  return { name, color, isDefault: body.is_default === true, memberIds, primaryIds };
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const [{ data: sectors, error: sectorError }, { data: memberships, error: memberError }] =
      await Promise.all([
        ctx.supabase
          .from('sectors')
          .select('id, account_id, name, color, is_default, is_active, created_at, updated_at')
          .eq('account_id', ctx.accountId)
          .order('is_active', { ascending: false })
          .order('name'),
        ctx.supabase
          .from('sector_members')
          .select('sector_id, user_id, is_primary')
          .eq('account_id', ctx.accountId),
      ]);

    if (sectorError || memberError) {
      console.error('[GET /api/sectors] load error:', sectorError ?? memberError);
      return NextResponse.json({ error: 'Falha ao carregar setores' }, { status: 500 });
    }

    const userIds = [...new Set((memberships ?? []).map((m) => m.user_id))];
    const { data: profiles, error: profileError } = userIds.length
      ? await ctx.supabase
          .from('profiles')
          .select('user_id, full_name, avatar_url, account_role')
          .eq('account_id', ctx.accountId)
          .in('user_id', userIds)
      : { data: [], error: null };

    if (profileError) {
      console.error('[GET /api/sectors] profile error:', profileError);
      return NextResponse.json({ error: 'Falha ao carregar membros dos setores' }, { status: 500 });
    }

    const profileById = new Map((profiles ?? []).map((p) => [p.user_id, p]));
    return NextResponse.json({
      sectors: (sectors ?? []).map((sector) => ({
        ...sector,
        members: (memberships ?? [])
          .filter((membership) => membership.sector_id === sector.id)
          .flatMap((membership) => {
            const profile = profileById.get(membership.user_id);
            return profile
              ? [{
                  user_id: membership.user_id,
                  full_name: profile.full_name ?? '',
                  avatar_url: profile.avatar_url,
                  role: profile.account_role,
                  is_primary: membership.is_primary,
                }]
              : [];
          }),
      })),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const input = parseInput((await request.json()) as SectorInput);
    if (input.name.length < 2 || input.name.length > 60) {
      return NextResponse.json({ error: 'Informe um nome entre 2 e 60 caracteres' }, { status: 400 });
    }

    const { data: validMembers, error: validError } = input.memberIds.length
      ? await ctx.supabase
          .from('profiles')
          .select('user_id')
          .eq('account_id', ctx.accountId)
          .in('user_id', input.memberIds)
      : { data: [], error: null };
    if (validError || (validMembers?.length ?? 0) !== input.memberIds.length) {
      return NextResponse.json({ error: 'Um ou mais usuários não pertencem à conta' }, { status: 400 });
    }

    if (input.isDefault) {
      const { error } = await ctx.supabase
        .from('sectors')
        .update({ is_default: false })
        .eq('account_id', ctx.accountId)
        .eq('is_default', true);
      if (error) throw error;
    }

    const { data: sector, error } = await ctx.supabase
      .from('sectors')
      .insert({
        account_id: ctx.accountId,
        name: input.name,
        color: input.color,
        is_default: input.isDefault,
        created_by_user_id: ctx.userId,
      })
      .select('id')
      .single();
    if (error) {
      return NextResponse.json(
        { error: error.code === '23505' ? 'Já existe um setor com esse nome' : 'Falha ao criar setor' },
        { status: error.code === '23505' ? 409 : 500 },
      );
    }

    if (input.memberIds.length) {
      const primary = new Set(input.primaryIds);
      for (const userId of input.memberIds) {
        if (primary.has(userId)) {
          await ctx.supabase
            .from('sector_members')
            .update({ is_primary: false })
            .eq('account_id', ctx.accountId)
            .eq('user_id', userId)
            .eq('is_primary', true);
        }
      }
      const { error: membershipError } = await ctx.supabase.from('sector_members').insert(
        input.memberIds.map((userId) => ({
          sector_id: sector.id,
          account_id: ctx.accountId,
          user_id: userId,
          is_primary: primary.has(userId),
        })),
      );
      if (membershipError) throw membershipError;
    }

    return NextResponse.json({ id: sector.id }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/sectors] error:', error);
    return toErrorResponse(error);
  }
}
