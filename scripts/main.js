Hooks.once('init', () => {
    console.log("WoD Fight Module | Initializing...");

    const originalSetupTurns = CONFIG.Combat.documentClass.prototype.setupTurns;

    // Override setupTurns to reverse the order strictly during the declaration phase
    CONFIG.Combat.documentClass.prototype.setupTurns = function() {
        const turns = originalSetupTurns.call(this);
        const isWodActive = this.getFlag("wod-fight-module", "active");
        const currentPhase = this.getFlag("wod-fight-module", "phase");

        if (isWodActive && currentPhase === "declaration") {
            // Reverse sorting, so lowest initiative goes first in declaration phase
            this.turns = turns.reverse();
            return this.turns;
        }
        
        return turns;
    };

    // Override nextTurn to handle phase switching
    const originalNextTurn = CONFIG.Combat.documentClass.prototype.nextTurn;
    CONFIG.Combat.documentClass.prototype.nextTurn = async function() {
        const isWodActive = this.getFlag("wod-fight-module", "active");
        
        if (isWodActive) {
            let turn = this.turn ?? -1;
            let skip = this.settings.skipDefeated;
            
            // Replicate core nextTurn to see if we go out of bounds
            let next = null;
            for ( let [i, t] of this.turns.entries() ) {
                if ( i <= turn ) continue;
                if ( t.isDefeated && skip ) continue;
                if ( t.initiative === null ) continue;
                next = i;
                break;
            }

            // If we've reached the end of the turns array in this phase
            if ( next === null ) {
                const currentPhase = this.getFlag("wod-fight-module", "phase");
                
                if (currentPhase === "declaration") {
                    // Reached end of declaration. Switch to execution phase, remain on same round
                    return this.update({
                        turn: 0,
                        "flags.wod-fight-module.phase": "execution"
                    });
                } else if (currentPhase === "execution") {
                    // Reached end of execution. Switch to declaration phase of NEXT round
                    return this.update({
                        round: this.round + 1,
                        turn: 0,
                        "flags.wod-fight-module.phase": "declaration"
                    });
                }
            }
        }
        
        // Let core handle standard turn progression if not out of bounds
        return originalNextTurn.call(this);
    };

    // Override previousTurn to handle backwards phase switching
    const originalPreviousTurn = CONFIG.Combat.documentClass.prototype.previousTurn;
    CONFIG.Combat.documentClass.prototype.previousTurn = async function() {
        const isWodActive = this.getFlag("wod-fight-module", "active");

        if (isWodActive) {
            let turn = this.turn ?? 0;
            let skip = this.settings.skipDefeated;
            
            let prev = null;
            for ( let i = turn - 1; i >= 0; i-- ) {
                let t = this.turns[i];
                if ( t.isDefeated && skip ) continue;
                if ( t.initiative === null ) continue;
                prev = i;
                break;
            }

            // If moving backwards past the first turn in this phase
            if ( prev === null ) {
                const currentPhase = this.getFlag("wod-fight-module", "phase");

                if (currentPhase === "execution") {
                    // Go back to the end of the declaration phase of the SAME round
                    return this.update({
                        turn: this.turns.length - 1,
                        "flags.wod-fight-module.phase": "declaration"
                    });
                } else if (currentPhase === "declaration" && this.round > 1) {
                    // Go back to the end of the execution phase of the PREVIOUS round
                    return this.update({
                        round: this.round - 1,
                        turn: this.turns.length - 1,
                        "flags.wod-fight-module.phase": "execution"
                    });
                } else if (currentPhase === "declaration" && this.round === 1) {
                    // Already at the very beginning of combat, do nothing
                    return this;
                }
            }
        }
        
        return originalPreviousTurn.call(this);
    };

    // Replace nextRound / previousRound if they click the explicit big round buttons
    const originalNextRound = CONFIG.Combat.documentClass.prototype.nextRound;
    CONFIG.Combat.documentClass.prototype.nextRound = async function() {
        const isWodActive = this.getFlag("wod-fight-module", "active");
        if (isWodActive) {
            return this.update({
                round: Math.max(this.round, 0) + 1,
                turn: 0,
                "flags.wod-fight-module.phase": "declaration"
            });
        }
        return originalNextRound.call(this);
    };

    const originalPreviousRound = CONFIG.Combat.documentClass.prototype.previousRound;
    CONFIG.Combat.documentClass.prototype.previousRound = async function() {
        const isWodActive = this.getFlag("wod-fight-module", "active");
        if (isWodActive) {
            const round = Math.max(this.round - 1, 0);
            return this.update({
                round,
                turn: 0,
                "flags.wod-fight-module.phase": "declaration"
            });
        }
        return originalPreviousRound.call(this);
    };
});


Hooks.on('renderCombatTracker', (app, html, data) => {
    html = $(html);
    if (!game.combat) return;
  
    const isWodActive = game.combat.getFlag("wod-fight-module", "active");
    const currentPhase = game.combat.getFlag("wod-fight-module", "phase") || "declaration";
  
    // Add the "Start WoD Combat" button natively if game hasn't started
    if (!game.combat.started) {
        const combatControls = html.find('#combat-controls');
        const startBtn = combatControls.find('.combat-control[data-control="startCombat"]');
        
        if (startBtn.length) {
            // Add custom button next to the original
            const wodBtn = $(`<a class="combat-control" title="${game.i18n.localize('WOD_FIGHT.StartCombat')}"><i class="fas fa-moon"></i> ${game.i18n.localize('WOD_FIGHT.StartCombat')}</a>`);
            
            wodBtn.on('click', async (ev) => {
                ev.preventDefault();
                // Auto roll initiatives if missing
                if ( game.combat.combatants.some(c => c.initiative === null) ) {
                    await game.combat.rollAll();
                }
                // Start properly with phase zeroing
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
  
    // UI Additions for WoD mode
    if (isWodActive && game.combat.started) {
        // Phase Banner
        const phaseKey = currentPhase === "declaration" ? 'WOD_FIGHT.PhaseDeclaration' : 'WOD_FIGHT.PhaseExecution';
        const header = $(`<div class="wod-phase-header ${currentPhase}"><h3>${game.i18n.localize(phaseKey)}</h3></div>`);
        html.find('#combat-round').before(header);
  
        // Delay Turn Buttons for each combatant
        html.find('.directory-item.combatant').each((i, el) => {
            const combatantId = $(el).data('documentId');
            const combatant = game.combat.combatants.get(combatantId);
            
            if (combatant && combatant.initiative !== null) {
                const controls = $(el).find('.combatant-controls');
                
                const delayBtn = $(`<a class="combatant-control wod-delay-turn" title="${game.i18n.localize('WOD_FIGHT.DelayTurnTooltip')}"><i class="fas fa-hourglass-half"></i></a>`);
                
                delayBtn.on('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const newInit = combatant.initiative - 1;
                    await combatant.update({ initiative: newInit });
                });
                
                controls.prepend(delayBtn);
            }
        });
    }
});
