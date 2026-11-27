ALTER TABLE tokens ADD COLUMN expires_at INTEGER;
CREATE TABLE installation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    key_hash TEXT NOT NULL,
    session_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    workspace_id TEXT REFERENCES workspaces(id),
    member_id TEXT REFERENCES members(id),
    token_id TEXT REFERENCES tokens(id),
    completed_at TEXT
);
