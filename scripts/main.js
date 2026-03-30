// ─────────────────────────────────────────────────────────────────────────────
// WoD 20th Combat Tracker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to extract an attribute value from common WoD system data paths.
 */
function getWodAttribute(actor, attrName) {
    if (!actor || !actor.system) return 0;
    const sys = actor.system;
    
    // Check direct attributes (e.g. system.attributes.dexterity.value)
    if (sys.attributes?.[attrName]?.value !== undefined) {
        return parseInt(sys.attributes[attrName].value) || 0;
    }
    
    // Check physical/social/mental categories
    for (const cat of ["physical", "social", "mental"]) {
        if (sys.attributes?.[cat]?.[attrName]?.value !== undefined) {
            return parseInt(sys.attributes[cat][attrName].value) || 0;
        }
    }
    
    return 0; // Fallback
}

/**
 * Roll WoD initiative for a single combatant automatically from character sheet.
 * Formula: 1d10 + dexterity + wits
 * The stored value = roll_result + modifier (e.g. 9.4 means roll=5, dex+wits=4)
 * This fractional part is used as a tiebreaker (higher modifier wins).
 *
 * @param {Combatant} combatant
 * @returns {Promise<number|null>} The composite initiative value, or null if no actor.
 */
async function wodRollInitiative(combatant) {
    if (!combatant.actor) return null;
    const actorName = combatant.name ?? combatant.actor.name;

    const dex = getWodAttribute(combatant.actor, "dexterity");
    const wits = getWodAttribute(combatant.actor, "wits");
    const modifier = dex + wits;

    // Roll 1d10
    const roll = new Roll("1d10");
    await roll.evaluate();
    const dieResult = roll.total;

    // Show the roll result in chat
    const dexLocalized = game.i18n.localize("WOD_FIGHT.Dexterity");
    const witsLocalized = game.i18n.localize("WOD_FIGHT.Wits");
    await roll.toMessage({
        flavor: `${actorName} — ${game.i18n.localize("WOD_FIGHT.InitiativeRoll")}: ${dieResult} + ${modifier} (${dexLocalized} ${dex} + ${witsLocalized} ${wits}) = ${dieResult + modifier}`,
        speaker: ChatMessage.getSpeaker({ actor: combatant.actor })
    });

    // Store as composite value: whole = total, fraction = modifier
    // e.g. dieResult=5, modifier=4 → 9.04
    // Add a tiny random fraction (0.0001 to 0.0099) so that ties are broken 50/50 but remain stable for sorting.
    const randomTieBreaker = Math.random() * 0.0098 + 0.0001; 
    const composite = dieResult + modifier + (modifier / 100) + randomTieBreaker;
    
    return composite;
}

/**
 * Roll initiative for all combatants sequentially (one dialog each).
 * @param {Combat} combat
 */
async function wodRollAllInitiative(combat) {
    for (const combatant of combat.combatants) {
        const value = await wodRollInitiative(combatant);
        if (value !== null) {
            await combatant.update({ initiative: value });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sort combatant turns according to WoD phase rules.
//
// Initiative is stored as a composite float: integer part = total initiative,
// fractional part = modifier (dex+wits) encoded as /100.
//
// Example: roll=5, dex=2, wits=2 → stored as 9.04 (9 + 4/100)
// Tiebreaker: higher stored value wins (i.e. higher modifier wins).
// Full tie → 50/50 random.
// ─────────────────────────────────────────────────────────────────────────────
function wodSortTurns(turns, phase) {
    const sorted = [...turns];

    const compareInit = (a, b) => {
        const aInit = a.initiative;
        const bInit = b.initiative;

        const aNull = aInit === null || aInit === undefined;
        const bNull = bInit === null || bInit === undefined;
        if (aNull && bNull) return 0;
        if (aNull) return 1;
        if (bNull) return -1;

        const diff = aInit - bInit;
        if (Math.abs(diff) > 1e-9) return diff; // not equal
        
        // Fallback to name if exactly tied (shouldn't happen with random tiebreaker)
        return (a.name ?? "").localeCompare(b.name ?? "");
    };

    if (phase === "declaration") {
        // Ascending: lowest initiative declares first
        sorted.sort((a, b) => compareInit(a, b));
    } else {
        // Descending: highest initiative acts first
        sorted.sort((a, b) => compareInit(b, a));
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

    // ── rollInitiative (override to use WoD dialog) ────────────────────────────
    const originalRollInitiative = CONFIG.Combat.documentClass.prototype.rollInitiative;
    CONFIG.Combat.documentClass.prototype.rollInitiative = async function (ids, options = {}) {
        const isWodActive = this.getFlag("wod-fight-module", "active");
        if (!isWodActive) return originalRollInitiative.call(this, ids, options);

        // ids can be a single id or array
        const idArray = Array.isArray(ids) ? ids : [ids];
        for (const id of idArray) {
            const combatant = this.combatants.get(id);
            if (!combatant) continue;
            const value = await wodRollInitiative(combatant);
            if (value !== null) {
                await combatant.update({ initiative: value });
            }
        }
        return this;
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
                    await wodRollAllInitiative(this);
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
            await wodRollAllInitiative(this);
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
                // First set the flag so rollInitiative uses WoD dialog
                await game.combat.update({
                    round: 1,
                    turn: 0,
                    "flags.wod-fight-module.active": true,
                    "flags.wod-fight-module.phase": "declaration"
                });
                // Then roll initiative via WoD dialogs
                await wodRollAllInitiative(game.combat);
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
                    // Reduce only the integer part (the visible total) by 1,
                    // keeping the fractional tiebreaker intact.
                    await combatant.update({ initiative: combatant.initiative - 1 });
                });

                controls.prepend(delayBtn);
            }
        });
    }
});
