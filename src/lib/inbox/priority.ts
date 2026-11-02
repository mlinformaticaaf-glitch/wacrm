import type { Conversation, ConversationStatus } from '@/types';

export type InboxFilter = ConversationStatus | 'active' | 'all' | 'unread' | 'mine' | 'waiting';

const STATUS_PRIORITY = { pending: 0, open: 1, closed: 2 };

export function prioritizeConversations(
  conversations: Conversation[],
  filter: InboxFilter,
  userId?: string,
): Conversation[] {
  return conversations.filter((conversation) => {
    if (filter === 'all') return true;
    if (filter === 'closed') return conversation.status === 'closed';
    if (conversation.status === 'closed') return false;
    if (filter === 'active') return true;
    if (filter === 'unread') return conversation.unread_count > 0;
    if (filter === 'mine') return !!userId && conversation.assigned_agent_id === userId;
    if (filter === 'waiting') return !conversation.assigned_agent_id;
    return conversation.status === filter;
  }).sort((a, b) => {
    const status = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (status) return status;
    const unread = Number(b.unread_count > 0) - Number(a.unread_count > 0);
    if (unread) return unread;
    const timestamp = (conversation: Conversation) =>
      Date.parse(conversation.last_message_at || conversation.created_at) || 0;
    return timestamp(b) - timestamp(a);
  });
}
