"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { attachmentLimits, type AttachmentKind, type TaskAttachment } from "@/lib/task-attachments";

const supportedExtensions = ["docx", "xlsx", "xls", "csv", "txt", "md", "json", "png", "jpg", "jpeg", "webp"];

function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function kindOf(file: File): AttachmentKind | null {
  const extension = extensionOf(file.name);
  if (["png", "jpg", "jpeg", "webp"].includes(extension) || file.type.startsWith("image/")) return "image";
  if (extension === "docx") return "document";
  if (["xlsx", "xls", "csv"].includes(extension)) return "spreadsheet";
  if (["txt", "md", "json"].includes(extension)) return "text";
  return null;
}

function clipped(text: string) {
  // eslint-disable-next-line no-control-regex -- strip NUL bytes from pasted content
  const normalized = text.replace(/\u0000/g, "").trim();
  if (normalized.length <= attachmentLimits.maxTextCharacters) return { text: normalized, truncated: false };
  return { text: normalized.slice(0, attachmentLimits.maxTextCharacters), truncated: true };
}

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read the image"));
    reader.readAsDataURL(file);
  });
}

async function prepareAttachment(file: File): Promise<TaskAttachment> {
  const kind = kindOf(file);
  if (!kind) throw new Error(`Unsupported format for "${file.name}"`);
  if (file.size > attachmentLimits.maxFileBytes) throw new Error(`"${file.name}" exceeds 10 MB`);
  if (kind === "image" && file.size > attachmentLimits.maxImageBytes) throw new Error(`Image "${file.name}" exceeds 1.8 MB`);

  const base = {
    id: `${Date.now()}-${crypto.randomUUID()}`,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    kind,
  } satisfies Omit<TaskAttachment, "text" | "dataUrl" | "truncated">;

  if (kind === "image") return { ...base, dataUrl: await readAsDataUrl(file) };
  if (kind === "document") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    const content = clipped(result.value);
    if (!content.text) throw new Error(`No readable text could be extracted from "${file.name}"`);
    return { ...base, ...content };
  }
  if (kind === "spreadsheet" && extensionOf(file.name) !== "csv") {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true, sheetRows: 2_000 });
    const sheets = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const csv = sheet ? XLSX.utils.sheet_to_csv(sheet, { blankrows: false }) : "";
      return `## Worksheet: ${sheetName}\n${csv}`;
    });
    const content = clipped(sheets.join("\n\n"));
    if (!content.text) throw new Error(`No readable cells could be extracted from "${file.name}"`);
    return { ...base, ...content };
  }
  const content = clipped(await file.text());
  if (!content.text) throw new Error(`"${file.name}" is an empty file`);
  return { ...base, ...content };
}

function fileSize(size: number) {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function useVisionCapability() {
  const [visionEnabled, setVisionEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/capabilities")
      .then(async (response) => response.ok ? await response.json() as { vision?: boolean } : null)
      .then((body) => { if (active) setVisionEnabled(body?.vision === true); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  return visionEnabled;
}

export function AttachmentPicker({ attachments, setAttachments, disabled = false, visionEnabled = false }: {
  attachments: TaskAttachment[];
  setAttachments: (attachments: TaskAttachment[]) => void;
  disabled?: boolean;
  visionEnabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");

  async function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setError("");
    const available = attachmentLimits.maxFiles - attachments.length;
    if (available <= 0) { setError(`Each task supports up to ${attachmentLimits.maxFiles} attachments`); return; }
    const selected = files.slice(0, available);
    const existingBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
    if (existingBytes + selected.reduce((total, file) => total + file.size, 0) > attachmentLimits.maxTotalBytes) {
      setError("Total attachment size for this task cannot exceed 20 MB");
      return;
    }
    const existingImageBytes = attachments.filter((item) => item.kind === "image").reduce((total, item) => total + item.size, 0);
    const selectedImageBytes = selected.filter((file) => kindOf(file) === "image").reduce((total, file) => total + file.size, 0);
    if (existingImageBytes + selectedImageBytes > attachmentLimits.maxTotalImageBytes) {
      setError("Total image size for this task cannot exceed 3.5 MB");
      return;
    }
    setProcessing(true);
    const next = [...attachments];
    const errors: string[] = [];
    for (const file of selected) {
      if (next.some((item) => item.name === file.name && item.size === file.size)) continue;
      try { next.push(await prepareAttachment(file)); }
      catch (reason) { errors.push(reason instanceof Error ? reason.message : `Failed to read "${file.name}"`); }
    }
    setAttachments(next);
    if (files.length > available) errors.push(`Only the first ${attachmentLimits.maxFiles} attachments are kept`);
    setError(errors.join("; "));
    setProcessing(false);
  }

  return <div className="attachment-panel">
    <div className="attachment-toolbar">
      <button type="button" className="attach-button" disabled={disabled || processing || attachments.length >= attachmentLimits.maxFiles} onClick={() => inputRef.current?.click()}>
        <span>+</span>{processing ? "Reading files…" : "Add attachments"}
      </button>
      <input ref={inputRef} className="visually-hidden" type="file" multiple disabled={disabled || processing} accept={supportedExtensions.map((extension) => `.${extension}`).join(",")} onChange={selectFiles} />
      <span className="attachment-help">Word, Excel, CSV, TXT, PNG, JPG, etc. · up to 4 files</span>
    </div>
    {error && <div className="attachment-error" role="alert">{error}</div>}
    {attachments.length > 0 && <div className="attachment-list">
      {attachments.map((attachment) => <article className={`attachment-chip ${attachment.kind}`} key={attachment.id}>
        {attachment.kind === "image" && attachment.dataUrl ? <img src={attachment.dataUrl} alt="" /> : <span className="attachment-file-icon">{attachment.kind === "document" ? "W" : attachment.kind === "spreadsheet" ? "X" : "T"}</span>}
        <div><strong title={attachment.name}>{attachment.name}</strong><small>{fileSize(attachment.size)} · {attachment.kind === "image" ? (visionEnabled ? "Readable by the current model" : "Kept; the current model cannot read images") : (attachment.truncated ? "Text extracted (long file, truncated)" : "Readable content extracted")}</small></div>
        <button type="button" aria-label={`Remove attachment ${attachment.name}`} disabled={disabled} onClick={() => setAttachments(attachments.filter((item) => item.id !== attachment.id))}>×</button>
      </article>)}
    </div>}
    {attachments.some((attachment) => attachment.kind === "image") && !visionEnabled && <p className="vision-notice">Images were added to the task; the current LLM does not support multimodality, so agents only know the image file names. Image reading can be enabled after switching to a multimodal model.</p>}
  </div>;
}
