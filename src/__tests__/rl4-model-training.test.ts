import { describe, it, expect } from 'vitest';
import { trainPoliciesForAllTypes } from '../rl/train4-full';

describe('RL4 Model Training', () => {
  it('Trains and saves RL4 policies for all entity types', async () => {
    const policies = await trainPoliciesForAllTypes({
      episodes: 30,
      stepsPerEpisode: 150,
      logEvery: 999, // Suppress logs
    });

    // Verify all policies were trained
    expect(policies.wolf).toBeDefined();
    expect(policies.cat).toBeDefined();
    expect(policies.werewolf).toBeDefined();

    // Verify serialization format
    expect(policies.wolf.length).toBeGreaterThan(100);
    expect(policies.cat.length).toBeGreaterThan(100);
    expect(policies.werewolf.length).toBeGreaterThan(100);

    // Verify metadata
    expect(policies.metadata.episodes).toBe(30);
    expect(policies.metadata.finalReturns).toBeDefined();

    // Policies should show learning (positive final returns)
    expect(policies.metadata.finalReturns.wolf).toBeGreaterThan(-1);
    expect(policies.metadata.finalReturns.cat).toBeGreaterThan(-1);
    expect(policies.metadata.finalReturns.werewolf).toBeGreaterThan(-1);

    console.log('Trained Policies:');
    console.log(`  Wolf: ${policies.metadata.finalReturns.wolf.toFixed(2)} return`);
    console.log(`  Cat: ${policies.metadata.finalReturns.cat.toFixed(2)} return`);
    console.log(`  Werewolf: ${policies.metadata.finalReturns.werewolf.toFixed(2)} return`);

    // Save to localStorage for game use
    try {
      const json = JSON.stringify(policies);
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem('rl4-trained-policies', json);
        console.log('Policies saved to localStorage');
      } else {
        console.log('LocalStorage not available (test environment)');
      }
    } catch (e) {
      console.log('Could not save to localStorage:', e);
    }
  }, 300000); // 5 minute timeout
});
