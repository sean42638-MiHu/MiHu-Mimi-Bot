'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { test } = require('node:test');
const { resolveVipTheme, resolveVipVisual } = require('../utils/vipResolver');

const showcasePath = path.join(__dirname, '..', 'views', 'partials', 'vip_cards_showcase.ejs');
const cardCssPath = path.join(__dirname, '..', 'public', 'css', 'wallet_card.css');

function getAttribute(markup, name) {
    const match = markup.match(new RegExp(`\\b${name}="([^"]*)"`));
    return match ? match[1] : null;
}

test('Showcase renders future VIP tiers in numeric order with tier-owned theme and HEX', async () => {
    const vipTiers = [10, 9, 8].map((level, index) => ({
        level,
        name: `VIP ${level}`,
        color: ['#FF2D95', '#00E5FF', '#FFD700'][index],
        theme: resolveVipTheme(level),
        visual: resolveVipVisual(level)
    }));
    const html = await ejs.renderFile(showcasePath, { vipTiers });
    const buttons = [...html.matchAll(/<button\b[^>]*class="[^"]*btn-vip-preview-tab[^"]*"[^>]*>/g)]
        .map(match => match[0]);

    assert.deepEqual(buttons.map(button => Number(getAttribute(button, 'data-vip-level'))), [8, 9, 10]);
    assert.deepEqual(buttons.map(button => getAttribute(button, 'data-vip-theme')), ['royal', 'royal', 'royal']);
    assert.deepEqual(buttons.map(button => getAttribute(button, 'data-vip-color')), ['#FFD700', '#00E5FF', '#FF2D95']);
    assert.equal(getAttribute(buttons[0], 'aria-pressed'), 'true');
    assert.match(html, /data-vip-level="8" data-vip-theme="royal"/);
    assert.equal((html.match(/class="vip-premium-card vip-premium-card--preview/g) || []).length, 1);

    const rawTiersHtml = await ejs.renderFile(showcasePath, {
        vipTiers: vipTiers.map(({ level, name, color }) => ({ level, name, color }))
    });
    const rawTierButtons = [...rawTiersHtml.matchAll(/<button\b[^>]*class="[^"]*btn-vip-preview-tab[^"]*"[^>]*>/g)]
        .map(match => match[0]);
    assert.ok(rawTierButtons.every(button => getAttribute(button, 'data-vip-theme') === 'royal'));

    const css = fs.readFileSync(cardCssPath, 'utf8');
    assert.doesNotMatch(css, /\.vip-premium-card\[data-vip-level=/);
});

test('Empty VIP tiers render no fabricated fixed-level tabs or preview card', async () => {
    const html = await ejs.renderFile(showcasePath, { vipTiers: [] });
    assert.equal((html.match(/<button\b[^>]*btn-vip-preview-tab/g) || []).length, 0);
    assert.equal((html.match(/class="vip-premium-card vip-premium-card--preview/g) || []).length, 0);
    assert.match(html, /vip-showcase-empty/);
});
