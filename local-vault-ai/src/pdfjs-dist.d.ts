declare module "pdfjs-dist/build/pdf.mjs" {
  export {
    getDocument,
  } from "pdfjs-dist";
}

declare module "pdfjs-dist/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: any;
}
