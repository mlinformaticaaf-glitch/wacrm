import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  requestSMBAppDataSync,
  SMBAppSyncRequestError,
  type SMBAppSyncType,
} from '@/lib/whatsapp/meta-api';

interface StartSyncArgs {
  db: SupabaseClient;
  accountId: string;
  phoneNumberId: string;
  accessToken: string;
}

export interface CoexistenceSyncResult {
  started: boolean;
  alreadyStarted: boolean;
  inProgress: boolean;
  warnings: string[];
}

type SyncStream = {
  type: SMBAppSyncType;
  requestIdColumn: 'sync_contacts_request_id' | 'sync_history_request_id';
  claimIdColumn: 'sync_contacts_claim_id' | 'sync_history_claim_id';
  claimedAtColumn: 'sync_contacts_claimed_at' | 'sync_history_claimed_at';
  label: string;
};

const STREAMS: SyncStream[] = [
  {
    type: 'smb_app_state_sync',
    requestIdColumn: 'sync_contacts_request_id',
    claimIdColumn: 'sync_contacts_claim_id',
    claimedAtColumn: 'sync_contacts_claimed_at',
    label: 'Contatos',
  },
  {
    type: 'history',
    requestIdColumn: 'sync_history_request_id',
    claimIdColumn: 'sync_history_claim_id',
    claimedAtColumn: 'sync_history_claimed_at',
    label: 'Histórico',
  },
];

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (!(error instanceof SMBAppSyncRequestError) || !error.meta) return error.message
  const diagnostics = [
    error.meta.code !== undefined ? `código ${error.meta.code}` : null,
    error.meta.subcode !== undefined ? `subcódigo ${error.meta.subcode}` : null,
    error.meta.details ?? null,
    error.meta.fbtraceId ? `fbtrace_id ${error.meta.fbtraceId}` : null,
  ].filter(Boolean)
  return diagnostics.length > 0
    ? `${error.message} (${diagnostics.join('; ')})`
    : error.message
}

/**
 * Claim each one-shot Meta stream with a compare-and-set update before
 * calling Meta. Claims are deliberately not expired: after an ambiguous
 * network result, automatically retrying could repeat Meta's one-shot sync.
 */
export async function startCoexistenceSync(
  args: StartSyncArgs
): Promise<CoexistenceSyncResult> {
  const { data: config, error } = await args.db
    .from('whatsapp_config')
    .select(
      'sync_contacts_request_id, sync_history_request_id, sync_contacts_claim_id, sync_history_claim_id'
    )
    .eq('account_id', args.accountId)
    .eq('phone_number_id', args.phoneNumberId)
    .maybeSingle();
  if (error || !config)
    throw error ?? new Error('Coexistence configuration not found');

  const needed = STREAMS.filter((stream) => !config[stream.requestIdColumn]);
  if (needed.length === 0) {
    return {
      started: false,
      alreadyStarted: true,
      inProgress: false,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const claims: Array<{ stream: SyncStream; id: string; claimedAt: string }> =
    [];
  let inProgress = STREAMS.some((stream) => config[stream.claimIdColumn]);

  for (const stream of needed) {
    const id = randomUUID();
    const claimedAt = new Date().toISOString();
    const { data: claim, error: claimError } = await args.db
      .from('whatsapp_config')
      .update({
        [stream.claimIdColumn]: id,
        [stream.claimedAtColumn]: claimedAt,
        status: 'syncing',
        sync_started_at: claimedAt,
        sync_last_error: null,
        updated_at: claimedAt,
      })
      .eq('account_id', args.accountId)
      .eq('phone_number_id', args.phoneNumberId)
      .is(stream.requestIdColumn, null)
      .is(stream.claimIdColumn, null)
      .select('id')
      .maybeSingle();

    if (claimError) throw claimError;
    if (claim) claims.push({ stream, id, claimedAt });
    else inProgress = true;
  }

  let started = false;
  for (const claim of claims) {
    let requestId: string;
    try {
      requestId = await requestSMBAppDataSync({
        phoneNumberId: args.phoneNumberId,
        accessToken: args.accessToken,
        syncType: claim.stream.type,
      });
    } catch (syncError) {
      const reason = errorText(syncError);
      if (
        !(syncError instanceof SMBAppSyncRequestError) ||
        !syncError.retrySafe
      ) {
        warnings.push(
          `${claim.stream.label}: ${reason}; claim mantido para evitar uma sincronização duplicada.`
        );
        inProgress = true;
        continue;
      }

      const { data: released, error: releaseError } = await args.db
        .from('whatsapp_config')
        .update({
          [claim.stream.claimIdColumn]: null,
          [claim.stream.claimedAtColumn]: null,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', args.accountId)
        .eq('phone_number_id', args.phoneNumberId)
        .eq(claim.stream.claimIdColumn, claim.id)
        .select('id')
        .maybeSingle();

      if (releaseError || !released) {
        warnings.push(
          `${claim.stream.label}: ${reason}; não foi possível liberar a tentativa com segurança: ${errorText(releaseError ?? 'claim não encontrado')}`
        );
        inProgress = true;
      } else {
        warnings.push(`${claim.stream.label}: ${reason}`);
      }
      continue;
    }

    const { data: saved, error: saveError } = await args.db
      .from('whatsapp_config')
      .update({
        [claim.stream.requestIdColumn]: requestId,
        [claim.stream.claimIdColumn]: null,
        [claim.stream.claimedAtColumn]: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', args.accountId)
      .eq('phone_number_id', args.phoneNumberId)
      .eq(claim.stream.claimIdColumn, claim.id)
      .select('id')
      .maybeSingle();

    if (saveError || !saved) {
      warnings.push(
        `${claim.stream.label}: Meta aceitou a solicitação, mas não foi possível salvar o identificador; o claim foi mantido para evitar nova solicitação.`
      );
      inProgress = true;
      continue;
    }
    started = true;
  }

  if (warnings.length > 0) {
    const { data: updated, error: statusError } = await args.db
      .from('whatsapp_config')
      .update({
        status: 'degraded',
        sync_last_error: warnings.join(' | ').slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', args.accountId)
      .eq('phone_number_id', args.phoneNumberId)
      .select('id')
      .maybeSingle();
    if (statusError || !updated) {
      throw (
        statusError ?? new Error('Failed to persist coexistence sync warnings')
      );
    }
  }

  const { data: finalState, error: stateError } = await args.db
    .from('whatsapp_config')
    .select(
      'sync_contacts_request_id, sync_history_request_id, sync_contacts_claim_id, sync_history_claim_id'
    )
    .eq('account_id', args.accountId)
    .eq('phone_number_id', args.phoneNumberId)
    .maybeSingle();
  if (stateError || !finalState) {
    throw (
      stateError ??
      new Error('Coexistence configuration disappeared during sync')
    );
  }

  const allRequested = STREAMS.every(
    (stream) => finalState[stream.requestIdColumn]
  );
  return {
    started,
    alreadyStarted: allRequested && !started,
    inProgress:
      !allRequested &&
      STREAMS.some((stream) => finalState[stream.claimIdColumn]),
    warnings,
  };
}
