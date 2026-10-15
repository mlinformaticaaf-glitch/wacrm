'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Check, History, Loader2, UserCheck } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import type { AccountMember, Conversation, ConversationTransfer, Sector } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface ConversationRoutingProps {
  conversation: Conversation;
  onChange: (patch: { sector_id: string | null; assigned_agent_id: string | null }) => void;
}

export function ConversationRouting({ conversation, onChange }: ConversationRoutingProps) {
  const { user, canSendMessages } = useAuth();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [transfers, setTransfers] = useState<ConversationTransfer[]>([]);
  const [sectorId, setSectorId] = useState(conversation.sector_id ?? '');
  const [agentId, setAgentId] = useState(conversation.assigned_agent_id ?? '');
  const [note, setNote] = useState('');

  const loadOptions = useCallback(async () => {
    setLoading(true);
    try {
      const [sectorResponse, memberResponse, historyResponse] = await Promise.all([
        fetch('/api/sectors', { cache: 'no-store' }),
        fetch('/api/account/members', { cache: 'no-store' }),
        fetch(`/api/conversations/${conversation.id}/assignment`, { cache: 'no-store' }),
      ]);
      const [sectorPayload, memberPayload, historyPayload] = await Promise.all([
        sectorResponse.json(), memberResponse.json(), historyResponse.json(),
      ]);
      if (!sectorResponse.ok) throw new Error(sectorPayload.error || 'Falha ao carregar setores');
      if (!memberResponse.ok) throw new Error(memberPayload.error || 'Falha ao carregar equipe');
      setSectors((sectorPayload.sectors ?? []).filter((sector: Sector) => sector.is_active));
      setMembers(memberPayload.members ?? []);
      if (historyResponse.ok) setTransfers(historyPayload.transfers ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar transferência');
    } finally {
      setLoading(false);
    }
  }, [conversation.id]);

  useEffect(() => {
    setSectorId(conversation.sector_id ?? '');
    setAgentId(conversation.assigned_agent_id ?? '');
  }, [conversation.sector_id, conversation.assigned_agent_id]);

  useEffect(() => {
    if (open) void loadOptions();
  }, [open, loadOptions]);

  const selectedSector = sectors.find((sector) => sector.id === sectorId);
  const eligibleMembers = useMemo(() => {
    if (!sectorId) return members.filter((member) => member.role !== 'viewer');
    const allowed = new Set(selectedSector?.members.map((member) => member.user_id) ?? []);
    return members.filter((member) => allowed.has(member.user_id) && member.role !== 'viewer');
  }, [members, sectorId, selectedSector]);

  const sectorName = sectors.find((sector) => sector.id === conversation.sector_id)?.name;
  const assigneeName = members.find((member) => member.user_id === conversation.assigned_agent_id)?.full_name;

  async function updateAssignment(nextSectorId: string | null, nextAgentId: string | null, transferNote: string | null) {
    setSaving(true);
    try {
      const response = await fetch(`/api/conversations/${conversation.id}/assignment`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sector_id: nextSectorId,
          assigned_agent_id: nextAgentId,
          note: transferNote,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Falha ao transferir atendimento');
      onChange({ sector_id: nextSectorId, assigned_agent_id: nextAgentId });
      toast.success(nextAgentId === user?.id ? 'Atendimento assumido' : 'Atendimento transferido');
      setOpen(false);
      setNote('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao transferir atendimento');
    } finally {
      setSaving(false);
    }
  }

  const canClaimCurrent = !conversation.assigned_agent_id && (
    !conversation.sector_id || sectors.some((sector) =>
      sector.id === conversation.sector_id && sector.members.some((member) => member.user_id === user?.id)
    )
  );

  return (
    <>
      <div className="flex items-center gap-1">
        {canSendMessages && canClaimCurrent && user?.id ? (
          <button
            type="button"
            onClick={() => void updateAssignment(conversation.sector_id ?? null, user.id, null)}
            disabled={saving}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-primary hover:bg-muted disabled:opacity-60"
          >
            <UserCheck className="size-3.5" />
            <span className="hidden sm:inline">Assumir</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-7 max-w-36 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Transferir atendimento"
        >
          <ArrowRightLeft className="size-3.5 shrink-0" />
          <span className="hidden truncate sm:inline">{assigneeName || sectorName || 'Transferir'}</span>
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Transferir atendimento</DialogTitle>
            <DialogDescription>Escolha o setor e, se desejar, um responsável específico.</DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex justify-center py-10"><Loader2 className="size-6 animate-spin text-primary" /></div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor="routing-sector">Setor</Label>
                <select
                  id="routing-sector"
                  value={sectorId}
                  disabled={!canSendMessages}
                  onChange={(event) => {
                    setSectorId(event.target.value);
                    setAgentId('');
                  }}
                  className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">Sem setor</option>
                  {sectors.map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}
                </select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="routing-agent">Responsável</Label>
                <select
                  id="routing-agent"
                  value={agentId}
                  disabled={!canSendMessages}
                  onChange={(event) => setAgentId(event.target.value)}
                  className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">Fila do setor (sem responsável)</option>
                  {eligibleMembers.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {member.full_name || member.email || 'Usuário'}{member.user_id === user?.id ? ' (você)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="routing-note">Observação interna</Label>
                <Textarea
                  id="routing-note"
                  value={note}
                  disabled={!canSendMessages}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Contexto importante para quem receber o atendimento"
                  maxLength={500}
                  rows={3}
                />
              </div>

              {transfers.length > 0 && (
                <div className="border-t border-border pt-4">
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <History className="size-3.5" /> Histórico recente
                  </div>
                  <div className="space-y-2">
                    {transfers.slice(0, 4).map((transfer) => {
                      const toSector = sectors.find((sector) => sector.id === transfer.to_sector_id)?.name || 'Sem setor';
                      const toAgent = members.find((member) => member.user_id === transfer.to_agent_id)?.full_name;
                      return (
                        <div key={transfer.id} className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                          <div className="flex items-center gap-1.5 text-foreground">
                            <Check className="size-3 text-primary" />
                            {toSector}{toAgent ? ` · ${toAgent}` : ''}
                          </div>
                          {transfer.note && <p className="mt-1 break-words">{transfer.note}</p>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            {canSendMessages && (
              <Button
                onClick={() => void updateAssignment(sectorId || null, agentId || null, note || null)}
                disabled={saving || loading}
              >
                {saving && <Loader2 className="size-4 animate-spin" />}
                Confirmar transferência
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
