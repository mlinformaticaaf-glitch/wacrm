'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Loader2, Plus, Star, UsersRound } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import type { AccountMember, Sector } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';

const DEFAULT_COLOR = '#25D366';

interface SectorDraft {
  id?: string;
  name: string;
  color: string;
  isDefault: boolean;
  isActive: boolean;
  memberIds: string[];
  primaryMemberIds: string[];
}

const EMPTY_DRAFT: SectorDraft = {
  name: '',
  color: DEFAULT_COLOR,
  isDefault: false,
  isActive: true,
  memberIds: [],
  primaryMemberIds: [],
};

export function SectorsSettings() {
  const { canManageMembers } = useAuth();
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<SectorDraft | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sectorResponse, memberResponse] = await Promise.all([
        fetch('/api/sectors', { cache: 'no-store' }),
        fetch('/api/account/members', { cache: 'no-store' }),
      ]);
      const sectorPayload = await sectorResponse.json();
      const memberPayload = await memberResponse.json();
      if (!sectorResponse.ok) throw new Error(sectorPayload.error || 'Falha ao carregar setores');
      if (!memberResponse.ok) throw new Error(memberPayload.error || 'Falha ao carregar usuários');
      setSectors(sectorPayload.sectors ?? []);
      setMembers(memberPayload.members ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar setores');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(
    () => [...sectors].sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name)),
    [sectors],
  );

  function editSector(sector: Sector) {
    setDraft({
      id: sector.id,
      name: sector.name,
      color: sector.color,
      isDefault: sector.is_default,
      isActive: sector.is_active,
      memberIds: sector.members.map((member) => member.user_id),
      primaryMemberIds: sector.members.filter((member) => member.is_primary).map((member) => member.user_id),
    });
  }

  function toggleMember(userId: string) {
    setDraft((current) => {
      if (!current) return current;
      const selected = current.memberIds.includes(userId);
      return {
        ...current,
        memberIds: selected ? current.memberIds.filter((id) => id !== userId) : [...current.memberIds, userId],
        primaryMemberIds: selected
          ? current.primaryMemberIds.filter((id) => id !== userId)
          : current.primaryMemberIds,
      };
    });
  }

  function togglePrimary(userId: string) {
    setDraft((current) => {
      if (!current || !current.memberIds.includes(userId)) return current;
      return {
        ...current,
        primaryMemberIds: current.primaryMemberIds.includes(userId)
          ? current.primaryMemberIds.filter((id) => id !== userId)
          : [...current.primaryMemberIds, userId],
      };
    });
  }

  async function save() {
    if (!draft || draft.name.trim().length < 2) {
      toast.error('Informe um nome para o setor');
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(draft.id ? `/api/sectors/${draft.id}` : '/api/sectors', {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name,
          color: draft.color,
          is_default: draft.isDefault,
          is_active: draft.isActive,
          member_ids: draft.memberIds,
          primary_member_ids: draft.primaryMemberIds,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Falha ao salvar setor');
      toast.success(draft.id ? 'Setor atualizado' : 'Setor criado');
      setDraft(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar setor');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="animate-in fade-in-50 space-y-5 duration-200">
      <SettingsPanelHead
        title="Setores de atendimento"
        description="Organize a equipe, defina o setor padrão e escolha o setor principal de cada usuário."
        action={canManageMembers ? (
          <Button onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            <Plus className="size-4" />
            Novo setor
          </Button>
        ) : undefined}
      />

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="size-6 animate-spin text-primary" /></div>
      ) : sorted.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center px-5 py-12 text-center">
            <Building2 className="size-8 text-muted-foreground" />
            <h3 className="mt-3 text-sm font-semibold text-foreground">Nenhum setor cadastrado</h3>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Crie setores como Comercial, Suporte ou Financeiro e vincule os usuários responsáveis.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {sorted.map((sector) => (
            <button
              key={sector.id}
              type="button"
              onClick={() => canManageMembers && editSector(sector)}
              className="flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/40 sm:flex-row sm:items-center"
            >
              <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: sector.color }} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{sector.name}</span>
                  {sector.is_default && <Badge className="border-primary/30 bg-primary/10 text-primary">Padrão</Badge>}
                  {!sector.is_active && <Badge variant="outline">Inativo</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {sector.members.length === 0
                    ? 'Sem usuários vinculados'
                    : sector.members.map((member) => member.full_name || 'Usuário').join(', ')}
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <UsersRound className="size-4" />
                {sector.members.length}
              </span>
            </button>
          ))}
        </div>
      )}

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? 'Editar setor' : 'Novo setor'}</DialogTitle>
            <DialogDescription>Selecione os usuários que poderão receber atendimentos deste setor.</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-5 py-2">
              <div className="grid gap-2">
                <Label htmlFor="sector-name">Nome</Label>
                <div className="flex gap-2">
                  <Input
                    id="sector-name"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder="Ex.: Suporte"
                    maxLength={60}
                    autoFocus
                  />
                  <input
                    type="color"
                    aria-label="Cor do setor"
                    value={draft.color}
                    onChange={(event) => setDraft({ ...draft, color: event.target.value })}
                    className="h-10 w-12 cursor-pointer rounded-md border border-border bg-card p-1"
                  />
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-border p-3">
                <label className="flex items-center justify-between gap-4">
                  <span>
                    <span className="block text-sm font-medium text-foreground">Setor padrão</span>
                    <span className="block text-xs text-muted-foreground">Novos atendimentos entram aqui automaticamente.</span>
                  </span>
                  <Switch checked={draft.isDefault} onCheckedChange={(checked) => setDraft({ ...draft, isDefault: checked })} />
                </label>
                {draft.id && (
                  <label className="flex items-center justify-between gap-4 border-t border-border pt-3">
                    <span>
                      <span className="block text-sm font-medium text-foreground">Setor ativo</span>
                      <span className="block text-xs text-muted-foreground">Setores inativos não recebem novas transferências.</span>
                    </span>
                    <Switch checked={draft.isActive} onCheckedChange={(checked) => setDraft({ ...draft, isActive: checked })} />
                  </label>
                )}
              </div>

              <div>
                <div className="mb-2">
                  <h3 className="text-sm font-medium text-foreground">Usuários do setor</h3>
                  <p className="text-xs text-muted-foreground">A estrela marca este como setor principal do usuário.</p>
                </div>
                <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {members.map((member) => {
                    const selected = draft.memberIds.includes(member.user_id);
                    const primary = draft.primaryMemberIds.includes(member.user_id);
                    return (
                      <div key={member.user_id} className="flex items-center gap-3 px-3 py-2.5">
                        <Checkbox checked={selected} onCheckedChange={() => toggleMember(member.user_id)} />
                        <button type="button" onClick={() => toggleMember(member.user_id)} className="min-w-0 flex-1 text-left">
                          <span className="block truncate text-sm text-foreground">{member.full_name || member.email || 'Usuário'}</span>
                          <span className="block text-xs text-muted-foreground">{member.role}</span>
                        </button>
                        <button
                          type="button"
                          disabled={!selected}
                          onClick={() => togglePrimary(member.user_id)}
                          aria-label={primary ? 'Remover setor principal' : 'Definir como setor principal'}
                          className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-30"
                        >
                          <Star className={primary ? 'size-4 fill-primary text-primary' : 'size-4'} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>Cancelar</Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Salvar setor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
