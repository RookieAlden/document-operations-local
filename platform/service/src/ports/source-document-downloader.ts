export interface DownloadSourceDocumentRequest {
  url: string;
  filename: string;
  declaredMimeType: string | null;
  declaredSizeBytes: number | null;
  expectedSha256: string | null;
}

export interface DownloadedSourceDocument {
  content: Buffer;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface SourceDocumentDownloader {
  download(request: DownloadSourceDocumentRequest): Promise<DownloadedSourceDocument>;
}
