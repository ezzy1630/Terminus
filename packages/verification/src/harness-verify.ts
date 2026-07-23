/**
 * Independent verification of external harness results — SPEC §35.12.
 * Re-exports adapter-sdk helpers so verification engine can gate completion.
 */
export {
  independentlyVerifyHarnessResult,
  verifyAdapterCompletion,
  type IndependentVerificationInput,
  type AdapterResult,
} from "@terminus/adapter-sdk";

import {
  independentlyVerifyHarnessResult,
  type IndependentVerificationInput,
} from "@terminus/adapter-sdk";
import { ValidationError } from "@terminus/domain";

/**
 * Require independent harness verification before treating an external
 * adapter claim as completion evidence.
 */
export function assertHarnessIndependentlyVerified(
  input: IndependentVerificationInput,
): void {
  const result = independentlyVerifyHarnessResult(input);
  if (result.verifiedStatus !== "completed") {
    throw new ValidationError("external harness result failed independent verification", {
      reason: result.reason,
      discrepancies: result.discrepancies,
    });
  }
}
