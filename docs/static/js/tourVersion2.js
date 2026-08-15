// tourVersion2.js — Cinematic Guided Journey for Floodlines
//
// Drop-in replacement for tour.js. Exposes window.restartTour and
// window.FloodlinesTour for use by external callers (same public API
// as the original tour.js).
//
// Architecture:
//   • Single Shepherd tour, useModalOverlay: false throughout
//   • Transparent interaction blocker div during automated steps (steps 1–8)
//     prevents accidental user interaction without visually dimming the map
//   • All advancement uses step-scoped timers so stale callbacks never
//     fire tour.next() on the wrong step
//   • Step 0 (welcome) runs unblocked — user must explicitly opt in
//   • Subsequent steps are fully automated; user can cancel at any time via X
//   • On cancel or complete, dashboard resets to canonical state
//
// Design philosophy:
//   The tour is a narrated visual essay, not a UI tutorial.
//   The map is the visual protagonist. Each step answers one analytical
//   question and then advances. Dashboard transitions happen automatically;
//   the only required user action is opting into the tour.
//
// Story arc (9 acts across 10 steps):
//   Step 0  — Welcome / opt-in
//   Step 1  — The central question (Quadrant Analysis)
//   Step 2  — What is "need"? (Combined Need)
//   Step 3  — What is "funding"? (Mitigation Funding)
//   Step 4  — Where do they diverge? (Funding Gap → Quadrants)
//   Step 5  — The proactive question
//   Step 6  — Three ways to measure risk (model comparison)
//   Step 7  — Scatterplot: funding vs. need across all towns
//   Step 8  — Past damage vs. future risk (NFIP Claims)
//   Step 9  — Synthesis and call to action
//
// Table of Contents:
//   constants & tour state
//   localStorage helpers
//   Shepherd loading
//   DOM utilities
//   dashboard interaction helpers   — switchChoropleth(), switchPrimaryModel(), etc.
//   timer helpers                   — _tourTimeout(), _nextStep(), _clearTourTimers()
//   interaction blocking            — _addInteractionBlocker(), _removeInteractionBlocker()
//   cleanup                         — _cleanupTourState()
//   main tour                       — _runTour()
//   entry points                    — startTour(), restartTour()
//   page load & public API

(function () {
  "use strict";

  /////////////////////////////////////////////////////////////////////////////
  // Constants

  let tourCancelled = false; // set true on cancel to silence stale timers
  let tourTimers = []; // all pending setTimeout IDs for cleanup
  let interactionBlocker = null; // invisible click-blocking div (steps 1–8)
  let _starting = false; // guards against concurrent startTour() calls

  // Saved user selection — restored after tour so user's context is preserved.
  let savedSelectEl = null;
  let savedSelectValue = null;

  /////////////////////////////////////////////////////////////////////////////
  // Shepherd loading
  //
  // Lazy-loads Shepherd from the local vendor copy (preferred) with CDN
  // fallback. Returns a Promise that resolves when Shepherd is available.

  function _loadCss(href) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`link[href="${href}"]`)) return resolve();
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      let done = false;
      const tid = setTimeout(() => {
        done = true;
        reject(new Error("CSS timeout: " + href));
      }, 8000);
      l.onload = () => {
        if (!done) {
          clearTimeout(tid);
          resolve();
        }
      };
      l.onerror = () => {
        if (!done) {
          clearTimeout(tid);
          reject(new Error("CSS failed: " + href));
        }
      };
      document.head.appendChild(l);
    });
  }

  function _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Shepherd) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      let done = false;
      const tid = setTimeout(() => {
        done = true;
        reject(new Error("JS timeout: " + src));
      }, 10000);
      s.onload = () => {
        if (!done) {
          clearTimeout(tid);
          resolve();
        }
      };
      s.onerror = () => {
        if (!done) {
          clearTimeout(tid);
          reject(new Error("JS failed: " + src));
        }
      };
      document.head.appendChild(s);
    });
  }

  function ensureShepherd() {
    if (window.Shepherd) return Promise.resolve();
    const localCss = "./static/vendor/shepherd/shepherd.min.css";
    const localJs = "./static/vendor/shepherd/shepherd.v7.1.2.min.js";
    return _loadCss(localCss)
      .then(() => _loadScript(localJs))
      .then(() => {
        if (!window.Shepherd) throw new Error("local vendor missing");
      })
      .catch(() =>
        _loadCss(
          "https://cdn.jsdelivr.net/npm/shepherd.js@8.1.2/dist/css/shepherd.css",
        )
          .then(() =>
            _loadScript(
              "https://cdn.jsdelivr.net/npm/shepherd.js@8.1.2/dist/js/shepherd.min.js",
            ),
          )
          .catch((err) => {
            _showLoadError(err);
            throw err;
          }),
      );
  }

  function _showLoadError(err) {
    if (document.getElementById("fl-tour-error")) return;
    const d = document.createElement("div");
    d.id = "fl-tour-error";
    d.innerHTML =
      '<div class="fl-tour-error-inner">' +
      "<strong>Tour unavailable.</strong> Shepherd assets could not load. " +
      "Place shepherd.css and shepherd.min.js in ./static/vendor/shepherd/, then " +
      '<button id="fl-tour-retry">Retry</button>' +
      "</div>";
    (document.querySelector(".dashboard-header") || document.body).appendChild(
      d,
    );
    document.getElementById("fl-tour-retry").addEventListener("click", () => {
      d.remove();
      startTour();
    });
    console.error("Floodlines tour asset error:", err);
  }

  /////////////////////////////////////////////////////////////////////////////
  // DOM utilities

  function _delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function _scrollTo(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: "smooth", block: "end" });
    } catch (_) {}
  }

  /////////////////////////////////////////////////////////////////////////////
  // Dashboard interaction helpers
  //
  // These functions drive the dashboard by clicking DOM elements or dispatching
  // events, matching the approach of the original tour.js. They return Promises
  // that resolve after a short delay to allow map animations to settle.

  // Activate a choropleth button by its data-overlay value.
  function switchChoropleth(overlayValue) {
    const btn = document.querySelector(
      `#choropleth-control button[data-overlay="${overlayValue}"],` +
        `#choropleth-control-special button[data-overlay="${overlayValue}"]`,
    );
    if (!btn) return Promise.resolve();
    btn.click();
    return _delay(700);
  }

  // Switch the primary model selector (near the map).
  function switchPrimaryModel(overlayValue) {
    const group = document.querySelector("#model-selector-group");
    if (!group) return Promise.resolve();
    const input = group.querySelector(`input[data-overlay="${overlayValue}"]`);
    if (!input || group.querySelector("input:checked") === input)
      return Promise.resolve();
    input.checked = true;
    group
      .querySelectorAll("label")
      .forEach((l) => l.classList.remove("active"));
    input.closest("label")?.classList.add("active");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return _delay(800);
  }

  // Switch the secondary model selector (below the scatterplot).
  function switchSecondaryModel(overlayValue) {
    const group = document.querySelector("#model-selector-group-secondary");
    if (!group) return Promise.resolve();
    const input = group.querySelector(`input[data-overlay="${overlayValue}"]`);
    if (!input || group.querySelector("input:checked") === input)
      return Promise.resolve();
    input.checked = true;
    group
      .querySelectorAll("label")
      .forEach((l) => l.classList.remove("active"));
    input.closest("label")?.classList.add("active");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return _delay(800);
  }

  // Set the Statewide Percentile / VT Avg toggle. relative=true → "Compared to VT Avg".
  function setRelativeToggle(relative) {
    const toggle = document.getElementById("toggle-relative");
    if (!toggle || toggle.checked === relative) return Promise.resolve();
    toggle.checked = relative;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    return _delay(600);
  }

  // Deactivate a context layer button if it is currently active.
  function _deactivateContextLayer(overlayValue) {
    const btn = document.querySelector(
      `#context-controls button[data-overlay="${overlayValue}"]`,
    );
    if (btn?.classList.contains("active")) btn.click();
    return _delay(400);
  }

  // Select a town in the navbar dropdown by name.
  // Saves the previous value so it can be restored after the tour.
  function _selectTown(townName) {
    const sel = document.querySelector(
      "#towns-dropdown, #towns-control select, select",
    );
    if (!sel) return Promise.resolve(false);
    savedSelectEl = sel;
    savedSelectValue = sel.value;
    const lower = townName.toLowerCase();
    const opts = Array.from(sel.options || []);
    const opt =
      opts.find((o) => o.text.trim().toLowerCase() === lower) ||
      opts.find((o) => o.value.toLowerCase() === lower) ||
      opts.find((o) => {
        const t = o.text.trim().toLowerCase();
        return t.startsWith(lower) || lower.startsWith(t);
      }) ||
      opts.find((o) => o.value !== "" && o.text.trim().length > 0);
    if (!opt) return Promise.resolve(false);
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return _delay(400).then(() => true);
  }

  // Restore the dropdown to the value it held before the tour.
  function _restoreSelectEl() {
    if (!savedSelectEl) return;
    try {
      savedSelectEl.value = savedSelectValue;
      savedSelectEl.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}
    savedSelectEl = null;
    savedSelectValue = null;
  }

  // Resets the dashboard to its canonical post-load state:
  //   Quadrants active, Vermont-wide view ("top"), Risk per Person,
  //   Statewide Percentile, all context layers off.
  // Restores the user's original town selection at the end so their context
  // is preserved after the tour completes.
  function resetDashboard() {
    return switchChoropleth("Quadrants")
      .then(() => _selectTown("top"))
      .then(() => switchPrimaryModel("Risk per Person"))
      .then(() => setRelativeToggle(false))
      .then(() => _deactivateContextLayer("Population"))
      .then(() => _deactivateContextLayer("Funding Bubble"))
      .then(() => _deactivateContextLayer("River Corridors"))
      .then(() => _restoreSelectEl());
  }

  /////////////////////////////////////////////////////////////////////////////
  // Timer helpers (Waypoints architecture)
  //
  // _tourTimeout wraps setTimeout with two safety checks:
  //   1. tourCancelled flag — silences timers after tour.cancel()
  //   2. Step ID check — prevents a stale timer from advancing the wrong step
  //      if the user has manually navigated or the tour was restarted
  //
  // All timer IDs are stored in tourTimers so _clearTourTimers() can cancel
  // every pending callback in one call during cleanup.

  function _tourTimeout(stepId, fn, delayMs) {
    const id = setTimeout(() => {
      if (tourCancelled) return;
      if (window.tour?.getCurrentStep()?.id !== stepId) return;
      fn();
    }, delayMs);
    tourTimers.push(id);
    return id;
  }

  // Advance the tour only if the current step matches the expected step ID.
  function _nextStep(expectedStepId) {
    if (tourCancelled) return;
    if (window.tour?.getCurrentStep()?.id === expectedStepId)
      window.tour.next();
  }

  function _clearTourTimers() {
    tourTimers.forEach((id) => clearTimeout(id));
    tourTimers = [];
  }

  /////////////////////////////////////////////////////////////////////////////
  // Interaction blocking
  //
  // An invisible full-screen div (z-index 8000) that absorbs all pointer events
  // during automated steps (1–8), preventing accidental clicks on map controls,
  // choropleth buttons, or model selectors while the tour is narrating.
  //
  // Shepherd dialogs run at z-index 9999, so the cancel icon and buttons
  // remain fully accessible while the blocker is active.
  //
  // The blocker is NOT active during step 0 (user must opt in) and is removed
  // during step 9 (synthesis) so the user can interact freely after the story ends.

  function _addInteractionBlocker() {
    if (interactionBlocker) return;
    interactionBlocker = document.createElement("div");
    interactionBlocker.id = "fl-tour-v2-blocker";
    Object.assign(interactionBlocker.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      zIndex: "8000",
      cursor: "default",
      pointerEvents: "all",
    });
    document.body.appendChild(interactionBlocker);
  }

  function _removeInteractionBlocker() {
    if (interactionBlocker) {
      interactionBlocker.remove();
      interactionBlocker = null;
    }
  }

  /////////////////////////////////////////////////////////////////////////////
  // Cleanup
  //
  // Called on both cancel and complete. Cancels all pending timers and removes
  // the interaction blocker. resetDashboard() is called separately by each
  // exit path to ensure canonical state regardless of how the tour ends.

  function _cleanupTourState() {
    _clearTourTimers();
    _removeInteractionBlocker();
  }

  /////////////////////////////////////////////////////////////////////////////
  // Main tour
  //
  // All 10 steps are defined here. The tour runs as a single Shepherd.Tour
  // with useModalOverlay: false. Automated visual transitions are driven by
  // step-scoped timers (_tourTimeout). Text updates mid-step use
  // step.updateStepOptions({ text: ... }) to track the visual change.

  function _runTour() {
    const mapEl = document.getElementById("map-id");
    const choroplethEl = document.getElementById("choropleth-control");
    const quadrantEl = document.getElementById("choropleth-control-special");
    const relativeEl = document.getElementById("toggle-relative");
    const modelSelectorEl = document.getElementById("model-selector-group");
    const plotEl = document.getElementById("model-selector-group-secondary");

    const tour = new Shepherd.Tour({
      useModalOverlay: false,
      defaultStepOptions: {
        scrollTo: false,
        cancelIcon: { enabled: true },
        classes: "shepherd-floodlines",
      },
    });

    window.tour = tour;

    ///////////////////////////////////////////////////////////////////////////
    // STEP 0 — WELCOME / OPT-IN
    //
    // Unattached (dialog centered). Interaction blocker is NOT active yet.
    // The user decides whether to watch the tour before any blocking begins.
    // "I'll explore" completes the tour immediately (no dashboard changes made).
    // "Show me" enables the blocker and advances to the narrated sequence.
    tour.addStep({
      id: "welcome",
      text: [
        "<strong>Want to see the story behind the map?</strong>",
        "<br><br>",
        "Floodlines asks whether FEMA mitigation funding is keeping pace with where flood risk and vulnerability may be greatest across Vermont.",
        "<br><br>",
        "<em>About two minutes. No clicking required.</em>",
      ].join(""),
      buttons: [
        {
          text: "I'll explore",
          classes: "shepherd-button-secondary",
          action: _dismissTour,
        },
        {
          text: "Show me",
          classes: "shepherd-button-primary",
          action: () => {
            _addInteractionBlocker(); // blocker is now active for steps 1–8
            tour.next();
          },
        },
      ],
    });

    ///////////////////////////////////////////////////////////////////////////
    // STEP 1 — THE QUESTION
    //
    // Blocker is active. beforeShowPromise resets the dashboard to canonical
    // state (Quadrants, Risk per Person, Vermont-wide) before the dialog
    // appears. The map is the visual subject — let it breathe.
    tour.addStep({
      id: "question",
      attachTo: {
        element: "#map-id",
        on: "bottom",
      },
      popperOptions: {
        modifiers: [{ name: "offset", options: { offset: [0, 16] } }],
      },
      text: [
        "<strong>Are we investing in the places that may need it most?</strong>",
        "<br><br>",
        "Floodlines compares modeled flood risk, community vulnerability, and FEMA mitigation investment across Vermont.",
        "<br><br>",
        "The map tells the story.",
      ].join(""),
      beforeShowPromise: () =>
        resetDashboard().then(() => {
          // Map vertically centers better with scrollTo choroplethEl
          _scrollTo(choroplethEl);
          return _delay(400);
        }),
      when: {
        show: () => {
          _tourTimeout("question", () => _nextStep("question"), 10000);
        },
      },
    });

    ///////////////////////////////////////////////////////////////////////////
    // STEP 2 — COMBINED NEED
    //
    // switchChoropleth fires on show, so the map changes as the dialog appears.
    // The dialog text and the map view are aligned from the first frame.
    tour.addStep({
      id: "need",
      attachTo: {
        element: "#choropleth-control",
        on: "top",
      },
      popperOptions: {
        modifiers: [{ name: "offset", options: { offset: [0, 16] } }],
      },
      text: "<strong>Need</strong> combines two questions: where could flooding cause serious damage, and who would have the hardest time recovering?",
      when: {
        show: () => {
          switchChoropleth("Combined Need").then(() => {
            _tourTimeout("need", () => _nextStep("need"), 7000);
          });
        },
      },
    });

    ///////////////////////////////////////////////////////////////////////////
    // STEP 3 — MITIGATION FUNDING
    //
    // Maps where FEMA Hazard Mitigation Assistance has actually gone.
    tour.addStep({
      id: "funding-map",
      attachTo: {
        element: "#choropleth-control",
        on: "top",
      },
      popperOptions: {
        modifiers: [{ name: "offset", options: { offset: [0, 16] } }],
      },
      text: "<strong>Funding</strong> shows where FEMA mitigation investment has actually gone — grants obligated since 1990, adjusted for inflation.",
      when: {
        show: () => {
          switchChoropleth("Mitigation Funding").then(() => {
            _tourTimeout("funding-map", () => _nextStep("funding-map"), 7000);
          });
        },
      },
    });

    ///////////////////////////////////////////////////////////////////////////
    // STEP 4 — FUNDING GAP → QUADRANT SYNTHESIS
    //
    // Two-phase visual reveal. Phase 1 shows the Funding Gap to establish
    // divergence. Phase 2 switches to Quadrants and updates the text so the
    // narration tracks the visual: Quadrants are the synthesis of all three
    // concepts. The text update fires at the moment of the visual transition.
    tour.addStep({
      id: "gap",
      attachTo: {
        element: "#choropleth-control",
        on: "top",
      },
      popperOptions: {
        modifiers: [{ name: "offset", options: { offset: [0, 16] } }],
      },
      text: "Put the two together. <strong>Where does need exceed investment?</strong>",
      when: {
        show: () => {
          switchChoropleth("Funding Gap");

          // Phase 2: Quadrants synthesize the three concepts
          _tourTimeout(
            "gap",
            async () => {
              await _scrollTo(quadrantEl);

              if (tourCancelled || window.tour?.getCurrentStep()?.id !== "gap")
                return;

              await switchChoropleth("Quadrants");

              if (tourCancelled || window.tour?.getCurrentStep()?.id !== "gap")
                return;

              const step = window.tour?.getById("gap");
              if (step)
                step.updateStepOptions({
                  text: "But a gap alone doesn't tell us the whole story. The <strong>Quadrant Analysis</strong> puts need and investment into the same frame — revealing where they're aligned, and where they diverge.",
                });
            },
            6000,
          );

          _tourTimeout("gap", () => _nextStep("gap"), 12000);
        },
      },
    });

    ///////////////////////////////////////////////////////////////////////////
    // STEP 5 — THE PROACTIVE QUESTION
    //
    // Stays on Quadrant view. Establishes the dashboard's core argument:
    // mitigation can be compared against forward-looking risk models, not
    // just historical disaster records.
    tour.addStep({
      id: "proactive",
      attachTo: {
        element: "#choropleth-control-special",
        on: "top",
      },
      popperOptions: {
        modifiers: [{ name: "offset", options: { offset: [0, 16] } }],
      },
      text: [
        "Some <strong>underserved</strong> towns have substantial modeled need but relatively little mitigation funding. Others have <strong>no recorded FEMA mitigation investment</strong> in the dataset.",
        "<br><br>",
        "The map isn't predicting which town will flood next. It's asking a simpler question: <strong>which places might deserve a closer look before the next disaster?</strong>",
      ].join(""),
      when: {
        show: () => {
          _tourTimeout("proactive", () => _nextStep("proactive"), 15000);
        },
      },
    });

    ///////////////////////////////////////////////////////////////////////////
    // STEP 6 — THREE WAYS TO MEASURE RISK (major cinematic sequence)
    //
    // Cycles through all three risk models with incremental text updates.
    // Each model switch is visible in the map — same state, different geometry
    // of need. Text updates are timed to coincide with each visual transition
    // so the narration and the map stay synchronized throughout.
    tour.addStep({
      id: "three-models",
      attachTo: {
        element: "#model-selector-group",
        on: "top",
      },
      popperOptions: {
        modifiers: [{ name: "offset", options: { offset: [0, 16] } }],
      },
      text: "<strong>But even that question depends on how we define risk.</strong>",
      beforeShowPromise: () =>
        switchChoropleth("Funding Gap").then(() => {
          _scrollTo(modelSelectorEl);
          return _delay(400);
        }),
      when: {
        show: () => {
          // Start from Total Risk; let map settle before explaining
          switchPrimaryModel("Total Risk");

          _tourTimeout(
            "three-models",
            async () => {
              const step = window.tour?.getById("three-models");
              if (step)
                step.updateStepOptions({
                  text: [
                    "<strong>Total expected loss</strong> favors places with more property and infrastructure.",
                    "<br><br>",
                    "Larger towns tend to rank higher.",
                  ].join(""),
                });
            },
            5000,
          );

          // Switch to Risk per Person; map changes
          _tourTimeout(
            "three-models",
            async () => {
              await switchPrimaryModel("Risk per Person");

              if (
                tourCancelled ||
                window.tour?.getCurrentStep()?.id !== "three-models"
              )
                return;

              const step = window.tour?.getById("three-models");
              if (step)
                step.updateStepOptions({
                  text: [
                    "Divide by population — <strong>the geography changes.</strong>",
                    "<br><br>",
                    "<strong>Risk per Person</strong> surfaces smaller, highly exposed communities that total-loss measures can obscure.",
                  ].join(""),
                });
            },
            12000,
          );

          // Switch to FEMA Risk Index; map changes again
          _tourTimeout(
            "three-models",
            async () => {
              await switchPrimaryModel("FEMA Risk Index");

              if (
                tourCancelled ||
                window.tour?.getCurrentStep()?.id !== "three-models"
              )
                return;

              const step = window.tour?.getById("three-models");
              if (step)
                step.updateStepOptions({
                  text: [
                    "FEMA's own composite index produces yet another map.",
                    "<br><br>",
                    "<strong>Same state. Same towns. Different definition of risk. Different priorities.</strong>",
                  ].join(""),
                });
            },
            18000,
          );

          _tourTimeout("three-models", () => _nextStep("three-models"), 26000);
        },
      },
    });

    ///////////////////////////////////////////////////////////////////////////
    // STEP 7 — SCATTERPLOT
    //
    // beforeShowPromise scrolls to the scatterplot and restores Risk per Person
    // as a neutral starting point. On show, switches the secondary model so the
    // bubbles move visibly — Total Risk first, then Risk per Person. The visual
    // movement carries the argument: model choice reshapes who rises to the top.
    tour.addStep({
      id: "scatterplot",
      attachTo: {
        element: "#model-selector-group-secondary",
        on: "top",
      },
      popperOptions: {
        modifiers: [{ name: "offset", options: { offset: [0, 16] } }],
      },
      text: [
        "Each bubble is a Vermont town. Larger bubbles are larger populations.",
        "<br><br>",
        "If funding tracked need, points would cluster along a diagonal.",
        "<br>",
        "<strong>They don't.</strong>",
      ].join(""),
      beforeShowPromise: () =>
        switchPrimaryModel("Risk per Person").then(() => {
          _scrollTo(plotEl);
          return _delay(500);
        }),
      when: {
        show: () => {
          // Switch secondary model to Total Risk — bubbles move
          _tourTimeout(
            "scatterplot",
            async () => {
              await switchSecondaryModel("Total Risk");

              if (
                tourCancelled ||
                window.tour?.getCurrentStep()?.id !== "scatterplot"
              )
                return;

              const step = window.tour?.getById("scatterplot");
              if (step)
                step.updateStepOptions({
                  text: "<strong>Total Risk:</strong> towns with more property and infrastructure tend to rise.",
                });
            },
            5000,
          );

          // Switch back to Risk per Person — watch them move again
          _tourTimeout(
            "scatterplot",
            async () => {
              await switchSecondaryModel("Risk per Person");

              if (
                tourCancelled ||
                window.tour?.getCurrentStep()?.id !== "scatterplot"
              )
                return;

              const step = window.tour?.getById("scatterplot");
              if (step)
                step.updateStepOptions({
                  text: [
                    "Adjust for population — <strong>the bubbles move.</strong>",
                    "<br><br>",
                    "The definition of risk reshapes which communities appear most vulnerable.",
                  ].join(""),
                });
            },
            11000,
          );

          // Switch back to FEMA Risk Index — bubbles move again
          _tourTimeout(
            "scatterplot",
            async () => {
              await switchSecondaryModel("FEMA Risk Index");

              if (
                tourCancelled ||
                window.tour?.getCurrentStep()?.id !== "scatterplot"
              )
                return;

              const step = window.tour?.getById("scatterplot");
              if (step)
                step.updateStepOptions({
                  text: [
                    "But there's another question. Are these models telling us something different from the historical record?",
                  ].join(""),
                });
            },
            17000,
          );

          _tourTimeout("scatterplot", () => _nextStep("scatterplot"), 24000);
        },
      },
    });

    ///////////////////////////////////////////////////////////////////////////
    // STEP 8 — PAST DAMAGE VS FUTURE RISK (NFIP Claims)
    //
    // beforeShowPromise scrolls back to the map. On show, cycles through three
    // views: NFIP Claims (reactive benchmark) → Flood Risk (forward-looking) →
    // Quadrants (synthesis). Text updates coincide with each visual transition.
    // This step establishes the institutional tension at the heart of the project.
    tour.addStep({
      id: "reactive",
      attachTo: {
        element: "#choropleth-control",
        on: "top",
      },
      popperOptions: {
        modifiers: [{ name: "offset", options: { offset: [0, 16] } }],
      },
      text: "National Flood Insurance Program <strong>claims</strong> give us the historical record: where insured flood losses have already occurred.",
      beforeShowPromise: () =>
        // reset model; FEMA Risk Index disables Flood Risk overlay
        switchPrimaryModel("Risk per Person").then(() => {
          _scrollTo(choroplethEl);
          return _delay(300);
        }),
      when: {
        show: async () => {
          await switchChoropleth("NFIP Claims");

          // Transition to Flood Risk — forward-looking contrast
          _tourTimeout(
            "reactive",
            async () => {
              await switchChoropleth("Flood Risk");

              if (
                tourCancelled ||
                window.tour?.getCurrentStep()?.id !== "reactive"
              )
                return;

              const step = window.tour?.getById("reactive");
              if (step)
                step.updateStepOptions({
                  text: [
                    "<strong>Risk models</strong> ask where losses <em>could</em> occur, not where they already have.",
                    "<br><br>",
                    "The two geographies are related — but not the same.",
                  ].join(""),
                });
            },
            6000,
          );

          // Transition to Quadrants — synthesis and institutional framing
          _tourTimeout(
            "reactive",
            () => {
              const step = window.tour?.getById("reactive");
              if (step)
                step.updateStepOptions({
                  text: [
                    "<strong>Past losses and future risk tell different stories.</strong>",
                    "<br><br>",
                    "FEMA mitigation funding is necessarily informed by where disasters and losses have occurred.",
                    "<br><br>",
                    "Floodlines asks what becomes visible when we compare that history with forward-looking measures of risk and vulnerability.",
                    "<br><br>",
                    "Where might the two diverge — <strong>and what places deserve a closer look?</strong>",
                  ].join(""),
                });
            },
            11000,
          );

          _tourTimeout("reactive", () => _nextStep("reactive"), 26000);
        },
      },
    });

    ///////////////////////////////////////////////////////////////////////////
    // STEP 9 — SYNTHESIS / CALL TO ACTION
    //
    // Unattached (dialog centered). Interaction blocker removed in when.show
    // so the user is free to explore as soon as the step appears.
    // beforeShowPromise resets the dashboard to canonical state and scrolls
    // back to the map before the dialog appears.
    //
    // Combines three closing arguments:
    //   1. No single model is definitive.
    //   2. Lightweight screening models can flag places worth investigating.
    //   3. The useful question is: where could we act before the statistics arrive?
    tour.addStep({
      id: "synthesis",
      text: [
        "<strong>Floodlines isn't trying to produce one definitive ranking of Vermont towns.</strong>",
        "<br><br>",
        "Different models identify different communities. That's not a flaw — it's the point.",
        "<br><br>",
        "These models aren't definitive rankings. They're inexpensive screening tools for finding places worth investigating further — <em>before</em> the next disaster forces the question.",
        "<br><br>",
        "<em>Where could we act before the next disaster statistics arrive?</em>",
      ].join(""),
      beforeShowPromise: () =>
        // reset the dashboard to canonical state (Quadrants, Risk per Person, Vermont-wide) so the user can explore freely
        resetDashboard().then(() => {
          return _delay(400);
        }),
      when: {
        show: () => {
          // Remove blocker here (not in beforeShowPromise) so the map is visible
          // and interactive the moment the synthesis dialog appears.
          _removeInteractionBlocker();
        },
      },
      buttons: [
        {
          text: "Explore",
          classes: "shepherd-button-primary",
          action: () => {
            tour.complete();
          },
        },
      ],
    });

    ///////////////////////////////////////////////////////////////////////////
    // Cancel / complete handlers
    //
    // Cancel and complete paths clean up all tour artifacts (timers, blocker) and reset
    // the dashboard to canonical state. resetDashboard() is safe to call multiple
    // times — if step 9's beforeShowPromise already ran it, calling again is a
    // no-op on an already-canonical dashboard.
    //
    // _dismissTour() is a special case: it cancels the tour without resetting the dashboard,
    // so the user can explore in whatever state they left it. For step 0.

    // Fires when user clicks X, or when restartTour() calls tour.cancel().
    tour.on("cancel", () => {
      tourCancelled = true;
      _cleanupTourState();
      resetDashboard();
      window.tour = null;
    });

    // Fires on normal completion ("Explore" at step 9).
    tour.on("complete", () => {
      _cleanupTourState();
      resetDashboard();
      window.tour = null;
    });

    // Dismisses the tour immediately without resetting the dashboard ("I'll explore" at step 0).
    function _dismissTour() {
      _cleanupTourState();
      window.tour?.hide();
      window.tour = null;
    }

    tour.start();
  }

  /////////////////////////////////////////////////////////////////////////////
  // Entry points

  // Start the tour (idempotent — returns if already starting).
  function startTour() {
    if (_starting) return;
    _starting = true;
    ensureShepherd()
      .then(() => {
        if (window.Shepherd) {
          tourCancelled = false;
          _runTour();
        }
      })
      .catch((err) => console.warn("Floodlines tour start failed:", err))
      .finally(() => {
        _starting = false;
      });
  }

  // Safe restart: cancels any active tour, cleans up, then starts fresh.
  // Called from the nav "Take tour" button and from window.restartTour.
  function restartTour() {
    if (_starting) return;
    tourCancelled = true;
    if (window.tour) window.tour.cancel(); // fires tour.on("cancel") → cleanup
    _cleanupTourState();
    setTimeout(() => {
      tourCancelled = false;
      startTour();
    }, 400);
  }

  /////////////////////////////////////////////////////////////////////////////
  // Page load handler
  //
  // Prompts new visitors by starting the tour automatically,
  // which shows step 0 (the opt-in welcome).
  // Also injects a persistent "Take tour" button into the navbar.

  window.addEventListener("load", () => {
    startTour(); // always start for now (no prompt expiration logic yet)

    // Inject a "Take tour" button into the navbar if it doesn't already exist.
    const navTarget =
      document.querySelector(".navbar-left.navbar-brand-wrap") ||
      document.querySelector(".navbar-left") ||
      document.querySelector(".dashboard-header");

    if (navTarget && !document.getElementById("fl-tour-restart-btn")) {
      const btn = document.createElement("button");
      btn.id = "fl-tour-restart-btn";
      btn.className = "btn btn-link fl-tour-restart-btn";
      btn.setAttribute("aria-label", "Take the guided tour");
      btn.textContent = "Take tour";
      btn.addEventListener("click", restartTour);
      navTarget.appendChild(btn);
    }
  });

  /////////////////////////////////////////////////////////////////////////////
  // Public API
  //
  // window.restartTour — called by the nav button and any external trigger
  // window.FloodlinesTour — object API matching the original tour.js contract

  window.restartTour = restartTour;
  window.FloodlinesTour = {
    start: startTour,
    restart: restartTour,
  };
})();
