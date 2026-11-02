import { describe, expect, it } from 'vitest';
import type { Conversation, ConversationStatus } from '@/types';
import { prioritizeConversations } from './priority';

function conversation(id: string, status: ConversationStatus, unread = 0, date = '2026-10-19T10:00:00Z'): Conversation {
  return { id, status, unread_count: unread, created_at: date, updated_at: date, last_message_at: date, user_id: 'u1', contact_id: id };
}

describe('inbox priority', () => {
  const pending = conversation('pending', 'pending');
  const open = { ...conversation('open', 'open', 2), assigned_agent_id: 'u1' };
  const closed = { ...conversation('closed', 'closed', 4), assigned_agent_id: 'u1' };
  const rows = [closed, open, pending];

  it('hides completed conversations by default and puts pending conversations first', () => {
    expect(prioritizeConversations(rows, 'active')).toEqual([pending, open]);
    expect(rows).toEqual([closed, open, pending]);
  });

  it('keeps completed conversations available only in explicit history filters', () => {
    expect(prioritizeConversations(rows, 'all')).toEqual([pending, open, closed]);
    expect(prioritizeConversations(rows, 'closed')).toEqual([closed]);
    expect(prioritizeConversations(rows, 'unread')).toEqual([open]);
    expect(prioritizeConversations(rows, 'mine', 'u1')).toEqual([open]);
    expect(prioritizeConversations(rows, 'waiting')).toEqual([pending]);
    expect(prioritizeConversations(rows, 'mine')).toEqual([]);
  });

  it('sorts unread first within each status, then most recent activity', () => {
    const recent = conversation('recent', 'pending', 0, '2026-10-19T12:00:00Z');
    const unread = conversation('unread', 'pending', 1);
    const unreadRecent = conversation('unread-recent', 'pending', 1, '2026-10-19T11:00:00Z');
    expect(prioritizeConversations([recent, open, pending, unread, unreadRecent], 'active'))
      .toEqual([unreadRecent, unread, recent, pending, open]);
  });

  it('moves completed conversations out and restores reopened ones', () => {
    expect(prioritizeConversations([{ ...open, status: 'closed' }], 'active')).toEqual([]);
    expect(prioritizeConversations([{ ...closed, status: 'pending' }], 'active')).toHaveLength(1);
    expect(prioritizeConversations(rows, 'pending')).toEqual([pending]);
    expect(prioritizeConversations(rows, 'open')).toEqual([open]);
  });
});
