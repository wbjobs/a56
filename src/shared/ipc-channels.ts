export const IPC_CHANNELS = {
  GET_SYNC_STATUS: 'sync:get-status',
  SET_SYNC_FOLDER: 'sync:set-folder',
  START_SYNC: 'sync:start',
  STOP_SYNC: 'sync:stop',
  GET_FILES: 'sync:get-files',
  GET_CONFLICTS: 'sync:get-conflicts',
  RESOLVE_CONFLICT: 'sync:resolve-conflict',
  GET_PEERS: 'sync:get-peers',
  GET_EVENTS: 'sync:get-events',
  ON_SYNC_STATUS: 'sync:on-status',
  ON_FILES_CHANGED: 'sync:on-files-changed',
  ON_CONFLICTS_CHANGED: 'sync:on-conflicts-changed',
  ON_PEERS_CHANGED: 'sync:on-peers-changed',
  ON_EVENT: 'sync:on-event',
  SELECT_FOLDER: 'dialog:select-folder'
} as const;
