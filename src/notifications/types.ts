export type NotificationEvent =
  | { type: 'stream_created'; streamId: string; donorAddress: string; ngoId: string }
  | { type: 'stream_withdrawn'; streamId: string; amount: string }
  | { type: 'stream_cancelled'; streamId: string; settledToNgo: string; refundToDonor: string }
  | { type: 'ngo_approved'; ownerAddress: string; ngoId: string }
  | { type: 'ngo_revoked'; ownerAddress: string; ngoId: string };
