export type ExtractedQuestion={complete:true;rawText:string;stem:string;options:Array<{id:string;text:string}>};
export const OCR_EXTRACTION_PROMPT:string;
export function isDoubaoMiniModelId(value:unknown):boolean;
export function validateExtractedQuestion(value:unknown):ExtractedQuestion;
export function parseExtraction(content:string):ExtractedQuestion;
