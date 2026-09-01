export class AlignmentError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = "AlignmentError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class AlignmentAbortError extends AlignmentError {
  constructor(message = "정렬 작업이 취소되었습니다.", details = undefined) {
    super("ALIGNMENT_ABORTED", message, details);
    this.name = "AlignmentAbortError";
  }
}

export function alignmentInvariant(condition, code, message, details = undefined) {
  if (!condition) throw new AlignmentError(code, message, details);
}
