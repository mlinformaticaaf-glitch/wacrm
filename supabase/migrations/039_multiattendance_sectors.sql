-- ============================================================
-- 039_multiattendance_sectors.sql
-- Sectors, membership and auditable conversation transfers.
-- ============================================================

CREATE TABLE IF NOT EXISTS sectors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 60),
  color TEXT NOT NULL DEFAULT '#25D366',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sectors_account_name
  ON sectors(account_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_sectors_one_default
  ON sectors(account_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_sectors_account_active
  ON sectors(account_id, is_active, name);

DROP TRIGGER IF EXISTS set_updated_at ON sectors;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sectors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS sector_members (
  sector_id UUID NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sector_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sector_members_one_primary
  ON sector_members(account_id, user_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_sector_members_user
  ON sector_members(account_id, user_id);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS sector_id UUID REFERENCES sectors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conversations_sector_status
  ON conversations(account_id, sector_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_assignee_status
  ON conversations(account_id, assigned_agent_id, status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS conversation_transfers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_sector_id UUID REFERENCES sectors(id) ON DELETE SET NULL,
  to_sector_id UUID REFERENCES sectors(id) ON DELETE SET NULL,
  from_agent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  to_agent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  transferred_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_transfers_conversation
  ON conversation_transfers(conversation_id, created_at DESC);

ALTER TABLE sectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE sector_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sectors_select ON sectors;
DROP POLICY IF EXISTS sectors_modify ON sectors;
CREATE POLICY sectors_select ON sectors FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY sectors_modify ON sectors FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS sector_members_select ON sector_members;
DROP POLICY IF EXISTS sector_members_modify ON sector_members;
CREATE POLICY sector_members_select ON sector_members FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY sector_members_modify ON sector_members FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS conversation_transfers_select ON conversation_transfers;
CREATE POLICY conversation_transfers_select ON conversation_transfers FOR SELECT
  USING (is_account_member(account_id));

-- New conversations enter the account's default active sector.
CREATE OR REPLACE FUNCTION assign_default_conversation_sector()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sector_id IS NULL THEN
    SELECT id INTO NEW.sector_id
    FROM sectors
    WHERE account_id = NEW.account_id
      AND is_default = TRUE
      AND is_active = TRUE
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS before_conversation_default_sector ON conversations;
CREATE TRIGGER before_conversation_default_sector
  BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION assign_default_conversation_sector();

-- One atomic entry point for claim, release and transfer operations.
CREATE OR REPLACE FUNCTION transfer_conversation(
  p_conversation_id UUID,
  p_sector_id UUID DEFAULT NULL,
  p_agent_id UUID DEFAULT NULL,
  p_note TEXT DEFAULT NULL
) RETURNS conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conversation conversations%ROWTYPE;
  v_actor_account UUID;
  v_actor_role account_role_enum;
BEGIN
  SELECT account_id, account_role
    INTO v_actor_account, v_actor_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_actor_account IS NULL OR v_actor_role NOT IN ('owner', 'admin', 'agent') THEN
    RAISE EXCEPTION 'Insufficient role' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_conversation
  FROM conversations
  WHERE id = p_conversation_id AND account_id = v_actor_account
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_sector_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sectors
    WHERE id = p_sector_id AND account_id = v_actor_account AND is_active
  ) THEN
    RAISE EXCEPTION 'Invalid or inactive sector' USING ERRCODE = '23514';
  END IF;

  IF p_agent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = p_agent_id AND account_id = v_actor_account
      AND account_role IN ('owner', 'admin', 'agent')
  ) THEN
    RAISE EXCEPTION 'Invalid attendant' USING ERRCODE = '23514';
  END IF;

  IF p_sector_id IS NOT NULL AND p_agent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sector_members
    WHERE sector_id = p_sector_id AND user_id = p_agent_id
  ) THEN
    RAISE EXCEPTION 'Attendant does not belong to sector' USING ERRCODE = '23514';
  END IF;

  IF v_conversation.sector_id IS NOT DISTINCT FROM p_sector_id
     AND v_conversation.assigned_agent_id IS NOT DISTINCT FROM p_agent_id THEN
    RETURN v_conversation;
  END IF;

  INSERT INTO conversation_transfers (
    account_id, conversation_id, from_sector_id, to_sector_id,
    from_agent_id, to_agent_id, transferred_by_user_id, note
  ) VALUES (
    v_actor_account, p_conversation_id, v_conversation.sector_id, p_sector_id,
    v_conversation.assigned_agent_id, p_agent_id, auth.uid(), NULLIF(trim(p_note), '')
  );

  UPDATE conversations
  SET sector_id = p_sector_id,
      assigned_agent_id = p_agent_id,
      claimed_at = CASE WHEN p_agent_id IS NULL THEN NULL ELSE NOW() END,
      updated_at = NOW()
  WHERE id = p_conversation_id
  RETURNING * INTO v_conversation;

  RETURN v_conversation;
END;
$$;

ALTER FUNCTION transfer_conversation(UUID, UUID, UUID, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION transfer_conversation(UUID, UUID, UUID, TEXT)
  TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'conversation_transfers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE conversation_transfers;
  END IF;
END $$;
