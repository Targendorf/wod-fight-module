// ─────────────────────────────────────────────────────────────────────────────
// WoD 20th Combat Tracker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sort combatant turns according to WoD phase rules:
 *  - declaration: ascending (lowest initiative → first to declare)
 *  - execution:   descending (highest initiative → first to act)
 */
function wodSortTurns(turns, phase) {
    const sorted = [...turns];
    if (phase === "declaration") {
        sorted.sort((a, b) => {
            const aInit = a.initiative ?? 9999;
            const bInit = b.initiative ?? 9999;
            return aInit !== bInit ? aInit - bInit : (a.name ?? "").localeCompare(b.name ?? "");
        });
    } else {
        sorted.sort((a, b) => {
            const aInit = a.initiative ?? -9999;
            const bInit = b.initiative ?? -9999;
            return aInit !== bInit ? bInit - aInit : (a.name ?? "").localeCompare(b.name ?? "");
        });
    }
    return sorted;
}

// ─── Combat prototype overrides ───────────────────────────────────────────────

Hooks.once('setup', () => {
    console.log("WoD Fight Module | Setup hook fired.");

    // ── setupTurns ─────────────────────────────────────────────────────────────
    const originalSetupTurns = CONFIG.Combat.documentClass.prototype.setupTurns;
    CONFIG.Combat.documentClass.prototype.setupTurns = function () {
        const turns = originalSetupTurns.call(this);
        const isWodActive = this.getFlag("wod-fight-module", "active");
        const phase = this.getFlag("wod-fight-module", "phase") || "declaration";

        if (isWodActive) {
            this.turns = wodSortTurns(turns, phase);
            return this.turns;
        }
        return turns;
    };

    // ── nextTurn ───────────────────────────────────────────────────────────────
    const originalNextTurn = CONFIG.Combat.documentClass.prototype.nextTurn;
    CONFIG.Combat.documentClass.prototype.nextTurn = async function () {
        const isWodActive = this.getFlag("wod-fight-module", "active");

        if (isWodActive) {
            const turn = this.turn ?? -1;
            const skip = this.settings.skipDefeated;

            // Look for the next valid turn in the current sorted list
            let next = null;
            for (let [i, t] of this.turns.entries()) {
                if (i <= turn) continue;
                if (t.isDefeated && skip) continue;
                if (t.initiative === null) continue;
                next = i;
                break;
            }

            if (next === null) {
                const phase = this.getFlag("wod-fight-module", "phase");

                if (phase === "declaration") {
                    // End of declaration → switch to execution (same round)
                    return this.update({
                        turn: 0,
                        "flags.wod-fight-module.phase": "execution"
                    });
                } else {
                    // End of execution → re-roll initiative and start next round
                    const cIds = this.combatants.map(c => c.id);
                    if (cIds.length) await this.rollInitiative(cIds);
                    return this.update({
                        round: this.round + 1,
                        turn: 0,
                        "flags.wod-fight-module.phase": "declaration"
                    });
                }
            }
        }

        return originalNextTurn.call(this);
    };

    // ── previousTurn ───────────────────────────────────────────────────────────
    const originalPreviousTurn = CONFIG.Combat.documentClass.prototype.previousTurn;
    CONFIG.Combat.documentClass.prototype.previousTurn = async function () {
        const isWodActive = this.getFlag("wod-fight-module", "active");

        if (isWodActive) {
            const turn = this.turn ?? 0;
            const skip = this.settings.skipDefeated;

            let prev = null;
            for (let i = turn - 1; i >= 0; i--) {
                const t = this.turns[i];
                if (t.isDefeated && skip) continue;
                if (t.initiative === null) continue;
                prev = i;
                break;
            }

            if (prev === null) {
                const phase = this.getFlag("wod-fight-module", "phase");
                if (phase === "execution") {
                    return this.update({ turn: this.turns.length - 1, "flags.wod-fight-module.phase": "declaration" });
                } else if (this.round > 1) {
                    return this.update({ round: this.round - 1, turn: this.turns.length - 1, "flags.wod-fight-module.phase": "execution" });
                } else {
                    return this;
                }
            }
        }

        return originalPreviousTurn.call(this);
    };

    // ── nextRound ──────────────────────────────────────────────────────────────
    const originalNextRound = CONFIG.Combat.documentClass.prototype.nextRound;
    CONFIG.Combat.documentClass.prototype.nextRound = async function () {
        const isWodActive = this.getFlag("wod-fight-module", "active");
        if (isWodActive) {
            const cIds = this.combatants.map(c => c.id);
            if (cIds.length) await this.rollInitiative(cIds);
            return this.update({ round: Math.max(this.round, 0) + 1, turn: 0, "flags.wod-fight-module.phase": "declaration" });
        }
        return originalNextRound.call(this);
    };

    // ── previousRound ──────────────────────────────────────────────────────────
    const originalPreviousRound = CONFIG.Combat.documentClass.prototype.previousRound;
    CONFIG.Combat.documentClass.prototype.previousRound = async function () {
        const isWodActive = this.getFlag("wod-fight-module", "active");
        if (isWodActive) {
            return this.update({ round: Math.max(this.round - 1, 0), turn: 0, "flags.wod-fight-module.phase": "declaration" });
        }
        return originalPreviousRound.call(this);
    };
});

// ─── Re-sort on any combat update ─────────────────────────────────────────────
// This is the key hook that ensures the visual order in the tracker is always
// correct, even if Foundry rebuilds the turn list after our setupTurns call.
Hooks.on('updateCombat', (combat, changed, options, userId) => {
    const isWodActive = combat.getFlag("wod-fight-module", "active");
    if (!isWodActive) return;

    const phase = combat.getFlag("wod-fight-module", "phase") || "declaration";
    if (combat.turns && combat.turns.length) {
        combat.turns = wodSortTurns(combat.turns, phase);
    }
});

// ─── Combat Tracker UI ────────────────────────────────────────────────────────
Hooks.on('renderCombatTracker', (app, html, data) => {
    html = $(html);
    if (!game.combat) return;

    const isWodActive = game.combat.getFlag("wod-fight-module", "active");
    const currentPhase = game.combat.getFlag("wod-fight-module", "phase") || "declaration";

    // ── "Start WoD Combat" button ──────────────────────────────────────────────
    if (!game.combat.started) {
        const startBtn = html.find('[data-control="startCombat"], [data-action="startCombat"]');

        if (startBtn.length) {
            const btnTag = startBtn[0].tagName.toLowerCase();
            const btnClass = startBtn.attr('class') || 'combat-control';
            const wodBtn = $(`<${btnTag} class="${btnClass}" title="${game.i18n.localize('WOD_FIGHT.StartCombat')}"><i class="fas fa-moon"></i> ${game.i18n.localize('WOD_FIGHT.StartCombat')}</${btnTag}>`);

            wodBtn.on('click', async (ev) => {
                ev.preventDefault();
                const cIds = game.combat.combatants.map(c => c.id);
                if (cIds.length) await game.combat.rollInitiative(cIds);
                await game.combat.update({
                    round: 1,
                    turn: 0,
                    "flags.wod-fight-module.active": true,
                    "flags.wod-fight-module.phase": "declaration"
                });
            });

            startBtn.after(wodBtn);
        }
    }

    // ── WoD Active UI ─────────────────────────────────────────────────────────
    if (isWodActive && game.combat.started) {
        // Phase Banner
        html.find('.wod-phase-header').remove();
        const phaseKey = currentPhase === "declaration" ? 'WOD_FIGHT.PhaseDeclaration' : 'WOD_FIGHT.PhaseExecution';
        const header = $(`<div class="wod-phase-header ${currentPhase}"><h3>${game.i18n.localize(phaseKey)}</h3></div>`);
        const roundHeader = html.find('#combat-round, .combat-tracker-header');
        if (roundHeader.length) roundHeader.first().before(header);
        else html.find('.directory-list').before(header);

        // Delay Turn Buttons
        html.find('.combatant').each((i, el) => {
            const combatantId = $(el).data('documentId') || $(el).data('combatantId');
            const combatant = game.combat.combatants.get(combatantId);

            if (combatant && combatant.initiative !== null) {
                const controls = $(el).find('.combatant-controls');
                const delayBtn = $(`<a class="combatant-control wod-delay-turn" title="${game.i18n.localize('WOD_FIGHT.DelayTurnTooltip')}"><i class="fas fa-hourglass-half"></i></a>`);

                delayBtn.on('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    await combatant.update({ initiative: combatant.initiative - 1 });
                });

                controls.prepend(delayBtn);
            }
        });
    }
});
