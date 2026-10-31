// Provider identity is resolved by a trusted adapter, never by the language model.
export interface IncomingMessage {
  channel: 'telegram';
  messageId: string;
  externalUserId: string;
  text: string;
  sentAt: string;
}

export interface OutgoingMessage {
  text: string;
  quickReplies?: { id: string; label: string }[];
  handedOff: boolean;
}

export interface ChannelAdapter {
  send(externalUserId: string, reply: OutgoingMessage, idempotencyKey: string): Promise<void>;
}
