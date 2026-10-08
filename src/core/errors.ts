// Typed errors shared by every layer. The CLI maps `exitCode` straight to the process
// exit status, so these numbers are a documented contract (see `bf --help`).

export const ExitCode = {
    OK: 0,
    GENERAL: 1,
    VALIDATION: 2,
    CONNECTION: 3,
    REFUSED: 4,
    UNSUPPORTED: 5,
    CONFIRM_REQUIRED: 6,
    VERIFY_FAILED: 7,
    PARTIAL_FAILURE: 8,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export const EXIT_CODE_DOCS: Record<ExitCodeValue, string> = {
    0: "success",
    1: "general error",
    2: "validation error (unknown setting, value out of range, bad arguments)",
    3: "connection error (no port, port busy, timeout)",
    4: "refused by the flight controller (armed, command rejected)",
    5: "not supported by this firmware / API version",
    6: "confirmation required (re-run with --confirm)",
    7: "verification failed (value read back differs from what was written)",
    8: "partial failure (some lines of a batch failed; see error.details)",
};

export class BfError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly exitCode: ExitCodeValue = ExitCode.GENERAL,
        public readonly hint?: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = "BfError";
    }

    toJSON() {
        return { code: this.code, message: this.message, hint: this.hint, details: this.details };
    }
}

export const validationError = (message: string, hint?: string, details?: unknown) =>
    new BfError("VALIDATION", message, ExitCode.VALIDATION, hint, details);

export const connectionError = (message: string, hint?: string) => new BfError("CONNECTION", message, ExitCode.CONNECTION, hint);

export const timeoutError = (message: string) =>
    new BfError("TIMEOUT", message, ExitCode.CONNECTION, "check the cable/port, and that no other program (Configurator) holds the port");

export const refusedError = (message: string, hint?: string) => new BfError("REFUSED", message, ExitCode.REFUSED, hint);

export const armedError = () =>
    new BfError("FC_ARMED", "flight controller is armed; refusing to change configuration", ExitCode.REFUSED, "disarm the craft first");

export const unsupportedError = (message: string, hint?: string) => new BfError("UNSUPPORTED", message, ExitCode.UNSUPPORTED, hint);

export const confirmRequired = (action: string, flag = "--confirm") =>
    new BfError("CONFIRM_REQUIRED", `${action} is destructive; re-run with ${flag} to proceed`, ExitCode.CONFIRM_REQUIRED, `add ${flag}`);
