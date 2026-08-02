import type { Attachment } from "../../../shared/types";

/** Read a File object into an Attachment suitable for sending to the agent. */
export async function fileToAttachment(file: File): Promise<Attachment> {
  const dataUrl = await readAsDataURL(file);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mime = file.type || "application/octet-stream";

  let kind: Attachment["kind"] = "text";
  let text: string | undefined;
  if (mime.startsWith("image/")) {
    kind = "image";
  } else if (mime === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    kind = "pdf";
  } else if (mime.startsWith("text/") || isLikelyText(file.name)) {
    kind = "text";
    text = await file.text();
  }

  return {
    id,
    name: file.name,
    mimeType: mime,
    size: file.size,
    dataUrl,
    kind,
    text,
  };
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function isLikelyText(name: string): boolean {
  return /\.(txt|md|markdown|json|csv|tsv|log|xml|yml|yaml|toml|ini|cfg|js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|sh|bash|zsh|html|css|sql)$/i.test(
    name,
  );
}
