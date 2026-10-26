-- Empties ONLY the trades array inside each workspace_state row.
-- strategies (incl. checklists), accounts and admin_users are untouched.
-- version+1 makes every open client pull the empty state on its next poll.
UPDATE workspace_state
SET data = json_set(data, '$.trades', json('[]')),
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- Cached NOVA responses embed trade summaries; replaying them would resurrect old trades.
DELETE FROM nova_idempotency;
