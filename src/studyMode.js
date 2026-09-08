// Chapter 41 completion: Study Mode + Project Mode.
//
// Lives in its own file rather than extending productivityMode.js. That
// file's Pomodoro logic is a work/break PHASE-CYCLING state machine with
// a fixed timer; Study Mode and Project Mode are structurally simpler —
// a plain on/off timer with no phases and no fixed duration, started and
// stopped purely by user action. Bolting an unrelated on/off timer onto
// a phase-cycling machine would blur two genuinely different mechanics
// rather than share real logic, and productivityMode.js's Pomodoro
// internals are explicitly off-limits per the brief.
//
// Study Mode: single active/inactive timer, no label.
// Project Mode: same shape, but carries a user-supplied plain-text label.
// The two are tracked completely independently — main.js decides what
// (if anything) each one means visually; this module only owns the
// timers themselves.

const MAX_LABEL_LENGTH = 120; // sane cap against a pathological paste, not a real limit

function createStudyMode() {
  let studyActive = false;
  let studyStartedAt = 0;

  let projectActive = false;
  let projectStartedAt = 0;
  let projectLabel = '';

  function startStudy() {
    if (studyActive) return false;
    studyActive = true;
    studyStartedAt = Date.now();
    return true;
  }

  // Returns elapsed ms of the session that just ended, or null if nothing
  // was active — callers use null to decide there's nothing to record.
  function endStudy() {
    if (!studyActive) return null;
    const elapsedMs = Date.now() - studyStartedAt;
    studyActive = false;
    studyStartedAt = 0;
    return elapsedMs;
  }

  function getStudySnapshot() {
    return {
      active: studyActive,
      elapsedMs: studyActive ? Date.now() - studyStartedAt : 0
    };
  }

  function startProject(label) {
    if (projectActive) return false;
    const trimmed = String(label || '').trim();
    if (!trimmed) return false; // an unlabeled project session isn't meaningful to store
    projectActive = true;
    projectStartedAt = Date.now();
    projectLabel = trimmed.slice(0, MAX_LABEL_LENGTH);
    return true;
  }

  // Returns { elapsedMs, label } for the session that just ended, or null
  // if nothing was active.
  function endProject() {
    if (!projectActive) return null;
    const elapsedMs = Date.now() - projectStartedAt;
    const label = projectLabel;
    projectActive = false;
    projectStartedAt = 0;
    projectLabel = '';
    return { elapsedMs, label };
  }

  function getProjectSnapshot() {
    return {
      active: projectActive,
      label: projectLabel,
      elapsedMs: projectActive ? Date.now() - projectStartedAt : 0
    };
  }

  return {
    startStudy,
    endStudy,
    getStudySnapshot,
    startProject,
    endProject,
    getProjectSnapshot
  };
}

module.exports = { createStudyMode, MAX_LABEL_LENGTH };
