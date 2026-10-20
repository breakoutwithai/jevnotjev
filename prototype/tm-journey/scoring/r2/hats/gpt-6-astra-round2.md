Tree: `<primary checkout>-wt/20261020-tm-journey-prototypes`  
Branch: `feat/tm-journey-prototypes` · HEAD: `8ec469b`

Read-only review completed. All five `prototype-shots.ts --no-write --scroll --full --strict` attempts failed at server startup with `EADDRINUSE`, before Chromium launched. I inspected the HTML, JavaScript, supplied viewport PNGs and scroll PNGs instead. Source comparisons used local `origin/main` at `2f9e55c`.

Paths below are relative to the tree. No banned ranking wording, em/en dashes, testimonials, off-domain absolute URLs or load-time network requests were found in the five HTML files.

**p1-limit-rescue**

- **p1-H1 · BLOCKING · `index.html:137`**  -  The first viewport does not explain what visitors receive. “We’re designing a tool that paces it” describes a proposal; the map appears later. The page also omits the required Jev/product and TokenMax/use-case relationship. **Smallest fix:** explain the built week report immediately and name the proposed use case in the subsequent explanation.
- **p1-H2 · BLOCKING · `index.html:197`**  -  No first-viewport control reaches an example. The only control, “Help us decide…”, targets `#run`; the example is `#example` at line 421. **Smallest fix:** add a visible example link.
- **p1-H3 · BLOCKING · `index.html:174`**  -  The opening pacing half says only “DESIGN”. “Next, in rehearsal, not run yet” first appears in stage 2 at lines 287 - 288, beyond the supplied mobile first viewport plus one scroll. **Smallest fix:** place that qualification on the opening pacing half.
- **p1-H4 · BLOCKING · `index.html:455`**  -  “87% big model” and “Codex 15%” omit essential meanings. Their sources say “of Claude output, Opus-class” and “of the Codex week used” (`site/tm/index.html:98,109`). **Smallest fix:** restore the provider, denominator and used/remaining distinction visibly.
- **p1-H5 · BLOCKING · `index.html:500`**  -  “Follow the pacing work” is a `<span>`, so the promised second next step does nothing. **Smallest fix:** make it reach sourced work information on the allowed host or an in-page disclosure.
- **p1-H6 · BLOCKING · `index.html:463`**  -  `href="/guide/#tokenmax"` does not reach the live guide when this standalone prototype is opened locally or served by the permitted runner. **Smallest fix:** use the absolute allowed-host guide URL.
- **p1-H7 · BLOCKING · `claims.md:7`**  -  The pacing claim cites `FRAMING.md:6`, which says only “TokenMax is being designed and might be built if there is enough demand.” It does not specify pacing. **Smallest fix:** include the actual pacing source, `FRAMING.md:14`.
- **p1-H8 · BLOCKING · `index.html:534`**  -  Copy fallback adds “Selected: press Ctrl+C or Cmd+C”, making stage 4 **20 words**, above 18. The default-state count misses this revealed text. **Smallest fix:** shorten the status to fit the remaining three words.
- **p1-H9 · BLOCKING · `README.md:3`**  -  Against p5, “split-screen cinema” is primarily another illustration treatment of the same static journey: stopped worker, pacing design, privacy picture, prompt, identical sample, two doors. The changed frames and layout do not establish a distinct concept. **Smallest fix:** give one of the pair a materially different organizing idea or visitor interaction.

VERDICT p1: BLOCK (9)

**p2-receipt**

- **p2-H1 · BLOCKING · `index.html:14`**  -  “See your week. Help shape a tool to pace it” never establishes the required product relationship. “Jev!Jev” is a masthead, while TokenMax appears only inside the closed prompt; stage 2 contains only the ask and a blank receipt. **Smallest fix:** explain the built report and identify TokenMax as Jev’s proposed use case.
- **p2-H2 · BLOCKING · `index.html:14`**  -  Stage 1 contains **24 visible words**, excluding the masthead, against the 18-word stage limit. `README.md:16` reports the viewport count without acknowledging this separate failure. **Smallest fix:** remove six stage words or separate the opening viewport from stage 1.
- **p2-H3 · BLOCKING · `index.html:15`**  -  The stage-2 pacing illustration says only “DESIGN”, without the required rehearsal qualification. The opening qualification also scales to approximately **6.8 px** on the supplied mobile layout: 17 SVG units across a 900-unit viewBox rendered 362 px wide. **Smallest fix:** put the full qualification in readable HTML beside the pacing illustration.
- **p2-H4 · BLOCKING · `index.html:18`**  -  “Big-model 87%” and “Codex 15%” lose the source metrics’ meanings. The cited facts are Claude output on Opus and the Codex weekly allowance used. **Smallest fix:** restore those visible labels.
- **p2-H5 · BLOCKING · `index.html:19`**  -  “Follow the pacing work” targets `/guide/#tokenmax`. The cited guide section explains usage maps and links to an unrelated recorded comparison (`site/guide/index.html:25 - 30`); it does not show pacing-work progress. **Smallest fix:** provide a correctly labelled, sourced work destination.
- **p2-H6 · BLOCKING · `index.html:18`**  -  Both Guide navigation and the follow control use root-relative guide URLs, which fail in the standalone prototype context. **Smallest fix:** use the absolute allowed-host URL for the actual Guide link.
- **p2-H7 · BLOCKING · `claims.md:13`**  -  The register does not cover the prompt’s visible “last 7 days” setting. Additionally, row 20 cites `FRAMING.md:20` for pacing, but that line concerns approved participant summaries. **Smallest fix:** register the seven-day setting against `SKILL.md:14` and remove the unrelated citation.
- **p2-H8 · BLOCKING · `index.html:16`**  -  The safety sentence begins “Map sends nothing”, rather than the explicitly required “The map sends nothing…”. This is an exact-copy requirement failure, not an overstated-privacy finding. **Smallest fix:** add “The”; stage 3 then contains 18 words.
- **p2-O1 · OPTIONAL · `README.md:16`**  -  “The existing PNGs predate this rebuild” conflicts with the supplied captures’ visible current receipt layout and wording. **Smallest fix:** update capture provenance so the operator knows which evidence to trust.

VERDICT p2: BLOCK (8)

**p3-four-questions**

- **p3-H1 · BLOCKING · `index.html:182`**  -  “We are designing a tool that paces it” does not explain the built result visitors receive. The page also never explains Jev’s relationship to TokenMax. **Smallest fix:** introduce the week report plainly, then identify the proposed use case.
- **p3-H2 · BLOCKING · `index.html:170`**  -  The opening pacing half is mostly concealed by curtains and has no visible DESIGN or rehearsal label. Its accessible description supplies meaning that the first viewport does not display. **Smallest fix:** expose and label the concept directly.
- **p3-H3 · BLOCKING · `index.html:236`**  -  Stage 3 presents “Tool”, “Plan”, “Day”, “Prompt”, rather than understandable questions or choices. Clicking changes a reassurance chip in another stage; it neither collects an answer nor explains the current stage’s purpose. **Smallest fix:** state what choosing each card does and show the response beside the selection.
- **p3-H4 · BLOCKING · `index.html:267`**  -  The revealed “It explains first” promises agent behaviour. `claims.md:18` simultaneously says “agent compliance UNTESTED”; an instruction asking for an explanation does not prove that behaviour. **Smallest fix:** say “Prompt asks first” or equivalent conditional wording.
- **p3-H5 · BLOCKING · `claims.md:16`**  -  “Plan not read” cites `map.ts:690 - 708`, the public share payload schema. Absence from exported fields does not establish absence from input processing. **Smallest fix:** cite the actual parsing/projection implementation or remove the assertion.
- **p3-H6 · BLOCKING · `index.html:335`**  -  “87% big model” omits Claude output and Opus. Stage 5 also lacks a visible local “sample week” label; that explanation is in ARIA text and the distant footer. **Smallest fix:** label the example and metric visibly on the card.
- **p3-H7 · BLOCKING · `index.html:353`**  -  “Follow the pacing work” is a non-interactive `<div>`. `claims.md:45` acknowledges that no follow destination was sourced. **Smallest fix:** supply a genuine sourced destination or in-page work disclosure.
- **p3-H8 · BLOCKING · `index.html:345`**  -  The root-relative Guide link fails when the prototype is opened standalone. **Smallest fix:** use `https://jevnotjev.breakoutwithai.com/guide/#tokenmax`.
- **p3-H9 · BLOCKING · `index.html:278`**  -  The safety sentence was rewritten to “Only Share sends your week’s totals and a chosen nickname.” `claims.md:46` explicitly says this was shortened for budget, despite the mandated wording. **Smallest fix:** restore the required sentence and recover space elsewhere.
- **p3-H10 · BLOCKING · `claims.md:21`**  -  The generic “prompt text” row does not substantiate its “last 7 days” number: the cited framing, script-link and SKILL lines do not state that period. **Smallest fix:** register the setting against `SKILL.md:14`.
- **p3-H11 · BLOCKING · `claims.md:30`**  -  “Follow the pacing work, #236” is a DESIGN row containing a number, contrary to the explicit register rule. **Smallest fix:** separate the existing issue identifier into a BUILT reference row and keep the design claim number-free.
- **p3-H12 · BLOCKING · `index.html:351`**  -  Stage 6 has a `data-visual` figure but no inline SVG; its doors are CSS boxes. That violates the specified per-stage visual structure. **Smallest fix:** include the required inline SVG within this figure.

VERDICT p3: BLOCK (12)

**p4-sample-first**

- **p4-H1 · BLOCKING · `index.html:15`**  -  “We are designing a tool to pace your week” explains the proposal but not what the visitor gets now. Jev and the TokenMax use-case relationship are also absent from the explanation. **Smallest fix:** state the built report’s purpose and the product relationship plainly.
- **p4-H2 · BLOCKING · `index.html:15`**  -  “See sample” targets stage 2’s mixed illustration and design gauge, rather than the built sample result at `#read`. **Smallest fix:** target the actual sample result.
- **p4-H3 · BLOCKING · `index.html:19`**  -  A single Monday - Sunday strip runs beneath both halves: the stopped-worker half occupies the earlier days and the DESIGN half the later days. This visually turns two contrasting users into a sequence through the week. On mobile, “Next, in rehearsal, not run yet. Wed: 2 hits” also combines design status and measured data in one caption. **Smallest fix:** separate the illustrative comparison from the dated built example; keep measured hits visibly attached to that example.
- **p4-H4 · BLOCKING · `index.html:32`**  -  “87% big model” drops the denominator and model identity. The result panel also lacks a visible sample label, despite appearing after instructions to run the visitor’s own week. **Smallest fix:** label it “Sample week” and identify the percentage as Claude output on Opus.
- **p4-H5 · BLOCKING · `index.html:38`**  -  “Follow the pacing work” leads only to “BUILT: the map. DESIGN: issue 236, pacing work.” That supplies neither work details nor a further destination. **Smallest fix:** make the destination contain sourced information about the work.
- **p4-H6 · BLOCKING · `index.html:33`**  -  The root-relative Guide URL fails in the standalone prototype context. **Smallest fix:** use the absolute allowed-host guide URL.
- **p4-H7 · BLOCKING · `claims.md:12`**  -  Claim coverage omits the prompt’s seven-day setting and the JS-revealed day captions at `index.html:43`. The visible “DESIGN: issue 236” at line 40 is relegated to an unstatused note rather than a compliant register row and attaches a number to DESIGN. **Smallest fix:** register the period and interactive states; separate the existing issue reference from the number-free design claim.
- **p4-H8 · BLOCKING · `index.html:24`**  -  “Week totals and your chosen nickname go when you press Share” omits **only** and replaces the mandated safety wording. **Smallest fix:** restore the exact required sentence.
- **p4-O1 · OPTIONAL · `README.md:18`**  -  “Previous-round PNGs were removed” and “layout still needs browser capture” are stale against the supplied PNGs showing this layout. **Smallest fix:** record which revision those captures represent.

VERDICT p4: BLOCK (8)

**p5-before-after**

- **p5-H1 · BLOCKING · `index.html:237`**  -  “We’re designing a pacing tool” provides no plain explanation of the built report visitors get. The page also omits the required Jev/TokenMax relationship outside the closed prompt. **Smallest fix:** explain the report immediately and identify the proposed use case.
- **p5-H2 · BLOCKING · `index.html:434`**  -  “87% big model” omits Claude output and Opus; “Codex week 15%” does not say used. The card’s sample provenance is accessible text rather than a visible local label. **Smallest fix:** restore metric meanings and visibly label the sample.
- **p5-H3 · BLOCKING · `index.html:227`**  -  The opening pacing half has only “DESIGN”; stage 6 also omits “Next, in rehearsal, not run yet”. `claims.md:37` explicitly acknowledges the latter omission. **Smallest fix:** keep the required qualification beside both pacing presentations.
- **p5-H4 · BLOCKING · `index.html:472`**  -  “Follow the pacing work” is plain text, so the second next step is unavailable. **Smallest fix:** provide an actionable, sourced work destination.
- **p5-H5 · BLOCKING · `index.html:474`**  -  `/guide/#tokenmax` fails when following the README’s instruction to open `index.html` directly. **Smallest fix:** use the absolute allowed-host guide URL.
- **p5-H6 · BLOCKING · `claims.md:8`**  -  The pacing claim cites `FRAMING.md:6`, which states design status and conditional demand, not pacing. **Smallest fix:** add the actual pacing source at line 14.
- **p5-H7 · BLOCKING · `claims.md:28`**  -  The DESIGN row includes “issue 236”, violating the explicit number-free DESIGN rule. **Smallest fix:** register the existing issue separately as a BUILT reference.
- **p5-H8 · BLOCKING · `index.html:505`**  -  Copy failure reveals “Not copied: open See the prompt and copy it by hand.” Stage 4 then contains **27 words**, exceeding 18; the claimed default-state strict pass does not cover this state. **Smallest fix:** shorten the failure status to fit the remaining two words.
- **p5-H9 · BLOCKING · `README.md:3`**  -  Compared with p1, the six-panel comic changes illustration treatment and desktop arrangement while retaining the same proposition, static progression, prompt, sample and final choices. It is a re-skin rather than a fifth distinct concept. **Smallest fix:** give this concept a different organizing question or substantive visitor interaction.

VERDICT p5: BLOCK (9)

VERDICT: DONE