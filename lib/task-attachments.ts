export type AttachmentKind = "image" | "document" | "spreadsheet" | "text";

export type TaskAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  text?: string;
  dataUrl?: string;
  truncated?: boolean;
};

export const attachmentLimits = {
  maxFiles: 6,
  maxFileBytes: 10 * 1024 * 1024,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxTextCharacters: 40_000,
};

export function attachmentSummary(attachments: TaskAttachment[]) {
  return attachments.length ? attachments.map((attachment) => attachment.name).join(", ") : "";
}
