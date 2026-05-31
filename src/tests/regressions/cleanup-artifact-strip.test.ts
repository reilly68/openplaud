/**
 * Regression: cleanup-LLM meta-commentary leaking into transcripts.
 *
 * The transcription server runs an LLM cleanup pass (we send
 * `cleanup: "true"`). It sometimes emits a self-describing paragraph
 * ("Zde je vyčištěný přepis… odstraněny halucinace…") instead of only the
 * cleaned text, sometimes followed by a `***` separator. Because long
 * audio is chunked and concatenated, such a block can land mid-transcript.
 *
 * `stripCleanupArtifacts` removes those meta lines (and an adjacent lone
 * `***`) line-by-line. The critical property pinned here: it must NOT
 * span from a separator-less leak to a later `***` (an earlier
 * implementation did, eating ~5 KB of real transcript between two leaks),
 * and it must NOT touch legitimate content that merely contains the word
 * "vyčistění" or a stray markdown `***`.
 *
 * Cases mirror the five real production transcripts this was validated
 * against.
 */

import { describe, expect, it } from "vitest";
import { stripCleanupArtifacts } from "@/lib/transcription/format";

describe("stripCleanupArtifacts", () => {
    it("removes a 'Zde je vyčištěný přepis … ***' block", () => {
        const input = [
            "…požádám ho o vyjádření.",
            "",
            "Zde je vyčištěný přepis schůzky. Byla opravena interpunkce, text rozdělen do logických odstavců a odstraněny halucinace, opakující se fráze a nesrozumitelné fragmenty. Obsah a technické termíny zůstaly zachovány.",
            "",
            "***",
            "",
            "Stát. Soudruh byl z toho zmatený.",
        ].join("\n");
        const out = stripCleanupArtifacts(input);
        expect(out).not.toMatch(/vyčištěn/i);
        expect(out).not.toContain("***");
        expect(out).toContain("…požádám ho o vyjádření.");
        expect(out).toContain("Stát. Soudruh byl z toho zmatený.");
    });

    it("does NOT bridge a separator-less leak to a later ***", () => {
        // First leak has no trailing ***; a real *** appears much later
        // after legitimate content. The legit content in between MUST
        // survive.
        const input = [
            "Někdo se o to bude starat. Je tam dokonce jako v trzích.",
            "",
            "Zde je vyčištěný přepis. Byla odstraněna mluvní nečistota, opakující se fráze, halucinace a nesrozumitelné fragmenty. Obsah a technické termíny byly zachovány.",
            "",
            "V oblasti cybersecurity je důležitý dokument Security Program Requirements.",
            "",
            "Toto je naprosto legitimní obsah který musí zůstat zachován.",
            "",
            "***",
            "",
            "Pokračování textu.",
        ].join("\n");
        const out = stripCleanupArtifacts(input);
        expect(out).not.toMatch(/vyčištěn/i);
        expect(out).toContain("V oblasti cybersecurity");
        expect(out).toContain("naprosto legitimní obsah který musí zůstat");
        expect(out).toContain("Pokračování textu.");
    });

    it("catches the 'Níže je vyčištěná verze' and 'Vyčistil jsem přepis' variants", () => {
        const a = stripCleanupArtifacts(
            "Konec věty.\n\nTento přepis byl pravděpodobně generován automatickým rozpoznáváním řeči (ASR). Níže je vyčištěná verze, která zachovává technické termíny, ale odstraňuje halucinace, opakující se fráze a nesrozumitelné fragmenty.\n\n***\n\nReálný text.",
        );
        expect(a).toBe("Konec věty.\n\nReálný text.");

        const b = stripCleanupArtifacts(
            "Mluvili jsme spolu.\n\nVyčistil jsem přepis. Odstranil jsem opakování, nesrozumitelné fragmenty a halucinace, zachoval jsem technické termíny a rozdělil text do logických odstavců.\n\n***\n\nDalší řeč.",
        );
        expect(b).toBe("Mluvili jsme spolu.\n\nDalší řeč.");
    });

    it("leaves a legitimate spoken 'vyčistění' untouched", () => {
        const input =
            "Měl jsem tam nějaký úkon o nějaký to vyčistění. No tak dobře.";
        expect(stripCleanupArtifacts(input)).toBe(input);
    });

    it("leaves a stray markdown *** (no adjacent meta) untouched", () => {
        const input = "Bod jedna.\n\n***\n\nBod dva.";
        expect(stripCleanupArtifacts(input)).toBe(input);
    });

    it("returns clean text unchanged", () => {
        const input = "První věta.\n\nDruhá věta.";
        expect(stripCleanupArtifacts(input)).toBe(input);
    });
});
