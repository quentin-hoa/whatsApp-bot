const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// ─── CONFIGURATION ───────────────────────────────────────────────────────────
// Lance le bot une première fois, et quand "Bot prêt" s'affiche dans la console,
// tous tes groupes WhatsApp seront listés avec leur ID.
// Copie l'ID de ton groupe familial et remplace la valeur ci-dessous.
const GROUP_ID = 'XXXXXXXXXXX-XXXXXXXXXX@g.us';

// Destinataires du brief crypto quotidien (warm_session.sh).
// Remplace par les IDs trouvés dans la liste "Contacts" affichée au démarrage.
const CRYPTO_RECIPIENTS = [
    'XXXXXXXXXXXXXX@lid',
    'XXXXXXXXXXXXXX@lid',
];

const MESSAGES = {
    croquettesA: '🐱 Roxxy a mangé ses croquettes A !',
    croquettesB: '🐱 Roxxy a mangé ses croquettes B !',
    patee:       '🐱 Roxxy a mangé sa pâtée !',
};

// ─── CLIENT WHATSAPP ─────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
});

let clientReady = false;

client.on('qr', (qr) => {
    console.log('\nScanne ce QR code avec WhatsApp sur ton téléphone :\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    clientReady = true;
    console.log('\n✓ Bot WhatsApp connecté et prêt !\n');

    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    const contacts = chats.filter(c => !c.isGroup);

    console.log('Groupes WhatsApp disponibles :');
    groups.forEach(g => console.log(`  "${g.name}" → ${g.id._serialized}`));
    console.log('\n→ Copie l\'ID de ton groupe et remplace GROUP_ID dans bot.js\n');

    console.log('Contacts WhatsApp disponibles :');
    contacts.forEach(c => console.log(`  "${c.name || c.id.user}" → ${c.id._serialized}`));
    console.log('\n→ Copie tes IDs et remplace CRYPTO_RECIPIENTS dans bot.js\n');

    // Livre les notifs Claude mises en file pendant que le bot était déconnecté
    viderFileNotifs().catch(err => console.error('[claude] Erreur file :', err.message));
});

client.on('auth_failure', () => {
    console.error('Échec d\'authentification. Supprime le dossier .wwebjs_auth et relance.');
});

// Réponse à la demande "usage" : envoie le détail complet des limites Claude.
// (WhatsApp ne supporte plus les boutons pour les bots whatsapp-web.js,
// donc on répond à un mot-clé à la place.)
client.on('message', async (msg) => {
    if (msg.from.endsWith('@g.us')) return; // on ignore les groupes
    const texte = (msg.body || '').trim();

    if (/^wake up$/i.test(texte)) {
        await reveillerClaude(msg);
        return;
    }

    if (!/^(usage|limite|claude|status)\b/i.test(texte)) return;
    try {
        const usage = await recupererUsageAvecCache();
        await msg.reply(resumeUsageComplet(usage));
        console.log('[claude] Détail usage envoyé à', msg.from);
    } catch (err) {
        console.error('[claude] Usage à la demande impossible :', err.message);
        await msg.reply('⚠️ Impossible de récupérer l\'usage Claude : ' + err.message).catch(() => {});
    }
});

client.initialize();

// ─── SERVEUR HTTP — reçoit les ordres de server.js (port 3001) ───────────────
const server = http.createServer((req, res) => {
    const ROUTES = ['/send', '/send-text', '/check-claude'];
    if (req.method !== 'POST' || !ROUTES.includes(req.url)) {
        res.writeHead(404);
        return res.end();
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        try {
            if (req.url === '/check-claude') {
                // Vérification immédiate + résumé de l'usage (pas besoin de WhatsApp)
                const usage = await recupererUsageAvecCache();
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(resumeUsage(usage) + '\n');
                verifierLimiteClaude(usage).catch(err => console.error('[claude] Erreur :', err.message));
                return;
            }

            if (!clientReady) {
                res.writeHead(503);
                return res.end('Bot pas encore connecté à WhatsApp');
            }

            if (req.url === '/send') {
                const { choix } = JSON.parse(body);
                const message = MESSAGES[choix];

                if (!message) {
                    res.writeHead(400);
                    return res.end('Choix invalide');
                }

                await client.sendMessage(GROUP_ID, message);
                console.log(`[bot] Message envoyé : ${message}`);
                res.writeHead(200);
                return res.end('ok');
            }

            // /send-text : envoie un texte libre à une liste de destinataires
            // body : { "message": "..." } — destinataires fixés par CRYPTO_RECIPIENTS
            const { message } = JSON.parse(body);

            if (!message) {
                res.writeHead(400);
                return res.end('Message manquant');
            }

            for (const to of CRYPTO_RECIPIENTS) {
                await client.sendMessage(to, message);
            }
            console.log(`[bot] Brief envoyé à ${CRYPTO_RECIPIENTS.length} destinataire(s)`);
            res.writeHead(200);
            res.end('ok');
        } catch (err) {
            console.error('[bot] Erreur :', err.message);
            res.writeHead(500);
            res.end(err.message);
        }
    });
});

server.listen(3001, () => {
    console.log('✓ Serveur bot démarré sur le port 3001');
});

// ─── DÉTECTION LIMITE CLAUDE ─────────────────────────────────────────────────
// Interroge l'API usage d'Anthropic avec le token OAuth de Claude Code
// (~/.claude/.credentials.json). Vérification toutes les 5 minutes.
// Notifs autorisées de 07h30 à 01h30 ; hors fenêtre, les messages sont mis en
// file dans etat_claude.json et livrés à la prochaine vérification en fenêtre.
// Test manuel : curl -X POST http://localhost:3001/check-claude

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const ETAT_CLAUDE_PATH = path.join(__dirname, 'etat_claude.json');
const CLAUDE_RECIPIENTS = ['XXXXXXXXXXXXXX@lid']; // toi uniquement
const INTERVALLE_VERIF_MS = 5 * 60 * 1000;

// client_id OAuth public de Claude Code (nécessaire pour rafraîchir le token)
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// ─── RÉVEIL CLAUDE À DISTANCE ("wake up") ────────────────────────────────────
// Envoie un mini prompt (modèle haiku, le moins cher) pour démarrer la fenêtre
// de session 5h en avance, avant de rentrer. Un seul réveil autorisé
// par fenêtre de session pour ne pas la relancer inutilement.
const CLAUDE_BIN = path.join(os.homedir(), '.local', 'bin', 'claude'); // chemin absolu : PATH pas garanti sous systemd
const WAKE_CWD = path.join(os.homedir(), '.claude-wake'); // dossier vide, pas de CLAUDE.md à lire
const WAKE_DELAI_MS = 4 * 60 * 60 * 1000; // pas de re-réveil avant 4h (session dure 5h)

function execFileP(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, opts, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve(stdout);
        });
    });
}

async function reveillerClaude(msg) {
    const etat = lireEtat();
    const maintenant = Date.now();

    if (etat.dernierReveil && maintenant - etat.dernierReveil < WAKE_DELAI_MS) {
        const restant = Math.ceil((WAKE_DELAI_MS - (maintenant - etat.dernierReveil)) / 60000);
        await msg.reply(`🔔 Session déjà réveillée récemment. Réessaie dans ~${restant} min.`).catch(() => {});
        return;
    }

    let usage;
    try {
        usage = await recupererUsageAvecCache();
    } catch (err) {
        await msg.reply('⚠️ Claude injoignable : ' + err.message).catch(() => {});
        return;
    }

    const session = (usage.limits || []).find(l => l.kind === 'session');
    if (session && session.percent >= 100) {
        await msg.reply(`⛔ Limite session Claude déjà atteinte — reset ${formaterReset(session.resets_at)}`).catch(() => {});
        return;
    }

    await msg.reply('🔔 Réveil de Claude en cours…').catch(() => {});
    try {
        fs.mkdirSync(WAKE_CWD, { recursive: true });
        await execFileP(CLAUDE_BIN, ['-p', 'Dis juste bonjour en un mot.', '--model', 'haiku'], {
            cwd: WAKE_CWD,
            timeout: 60000,
        });
        etat.dernierReveil = maintenant;
        ecrireEtat(etat);
        console.log('[claude] Session réveillée via haiku');
        await msg.reply('✅ Claude réveillé, session lancée !').catch(() => {});
    } catch (err) {
        console.error('[claude] Réveil échoué :', err.message);
        await msg.reply('⚠️ Réveil échoué : ' + err.message).catch(() => {});
    }
}

const LIBELLES_LIMITES = {
    session: 'Limite 5h',
    weekly_all: 'Limite hebdo',
    weekly_scoped: 'Limite hebdo (modèle)',
};

// Fenêtre autorisée : 07h30 → 01h30 (silence de 01h30 à 07h29)
function estHeureAutorisee(date) {
    const totalMin = date.getHours() * 60 + date.getMinutes();
    return totalMin >= 7 * 60 + 30 || totalMin < 90;
}

function lireEtat() {
    try {
        return JSON.parse(fs.readFileSync(ETAT_CLAUDE_PATH, 'utf8'));
    } catch {
        return { initialise: false, limites: {}, enAttente: [], derniereAlerteToken: 0 };
    }
}

function ecrireEtat(etat) {
    fs.writeFileSync(ETAT_CLAUDE_PATH, JSON.stringify(etat, null, 2));
}

// Renvoie un access token valide, en le rafraîchissant si expiré.
// Le token rafraîchi est réécrit dans .credentials.json pour que Claude Code
// continue de fonctionner (même fichier, même format).
async function lireTokenClaude() {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const oauth = creds.claudeAiOauth;
    if (!oauth) throw new Error('auth: claudeAiOauth absent de .credentials.json');

    if (oauth.expiresAt && oauth.expiresAt - Date.now() > 60 * 1000) {
        return oauth.accessToken;
    }

    console.log('[claude] Token expiré → refresh OAuth');
    const rep = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: oauth.refreshToken,
            client_id: CLAUDE_OAUTH_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(15000),
    });
    if (!rep.ok) throw new Error(`auth: refresh token HTTP ${rep.status}`);

    const d = await rep.json();
    oauth.accessToken = d.access_token;
    if (d.refresh_token) oauth.refreshToken = d.refresh_token;
    oauth.expiresAt = Date.now() + d.expires_in * 1000;
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds));
    return oauth.accessToken;
}

async function recupererUsageClaude() {
    const token = await lireTokenClaude();
    const rep = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
            Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
    });
    if (rep.status === 401 || rep.status === 403) throw new Error(`auth: API usage HTTP ${rep.status}`);
    if (!rep.ok) throw new Error(`API usage HTTP ${rep.status}`);
    return rep.json();
}

function formaterReset(iso) {
    const d = new Date(iso);
    const heure = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return `à ${heure}`;
    const jour = d.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: '2-digit' });
    return `${jour} à ${heure}`;
}

function mettreEnFile(etat, message) {
    const now = new Date();
    if (!estHeureAutorisee(now)) {
        const h = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        message += ` (événement à ${h}, notif différée)`;
    }
    etat.enAttente.push(message);
    console.log('[claude] Notif en file :', message);
}

async function viderFileNotifs() {
    const etat = lireEtat();
    if (!etat.enAttente || !etat.enAttente.length) return;
    if (!clientReady || !estHeureAutorisee(new Date())) return;

    const restants = [];
    for (const msg of etat.enAttente) {
        try {
            for (const to of CLAUDE_RECIPIENTS) {
                await client.sendMessage(to, msg);
            }
            console.log('[claude] Notif envoyée :', msg);
        } catch (err) {
            console.error('[claude] Envoi échoué, réessai au prochain cycle :', err.message);
            restants.push(msg);
        }
    }
    etat.enAttente = restants;
    ecrireEtat(etat);
}

// Alerte WhatsApp si le token est mort (max 1 fois toutes les 6 h)
function alerterProblemeToken(etat, err) {
    if (!err.message.startsWith('auth:')) return; // erreur réseau/API passagère → silence
    if (Date.now() - (etat.derniereAlerteToken || 0) < 6 * 3600 * 1000) return;
    etat.derniereAlerteToken = Date.now();
    mettreEnFile(etat, '⚠️ Bot limite Claude : token OAuth invalide. Lance `claude` sur le Pi et reconnecte-toi (/login).');
    ecrireEtat(etat);
}

async function verifierLimiteClaude(usageDejaRecupere) {
    let usage = usageDejaRecupere;
    try {
        if (!usage) usage = await recupererUsageAvecCache();
    } catch (err) {
        console.error('[claude] Vérification impossible :', err.message);
        alerterProblemeToken(lireEtat(), err);
        await viderFileNotifs();
        return;
    }

    const etat = lireEtat();
    const premierPassage = !etat.initialise;

    for (const lim of usage.limits || []) {
        const libelle = LIBELLES_LIMITES[lim.kind] || lim.kind;
        const atteinte = lim.percent >= 100;
        const avant = etat.limites[lim.kind];

        if (!premierPassage && avant) {
            if (!avant.atteinte && atteinte) {
                mettreEnFile(etat, `⛔ ${libelle} Claude atteinte — reset ${formaterReset(lim.resets_at)}\n👉 Réponds "usage" pour le détail`);
            } else if (avant.atteinte && !atteinte) {
                mettreEnFile(etat, `✅ ${libelle} Claude reset — c'est reparti !\n👉 Réponds "usage" pour le détail`);
            }
        }
        etat.limites[lim.kind] = { atteinte, resetsAt: lim.resets_at };
    }

    if (premierPassage) {
        console.log('[claude] Premier passage : état initialisé sans notif —',
            (usage.limits || []).map(l => `${l.kind}=${l.percent}%`).join(' '));
    }
    etat.initialise = true;
    ecrireEtat(etat);
    await viderFileNotifs();
}

function resumeUsage(usage) {
    return (usage.limits || [])
        .map(l => `${LIBELLES_LIMITES[l.kind] || l.kind} : ${l.percent}% — reset ${formaterReset(l.resets_at)}`)
        .join('\n');
}

// Cache 60 s : évite le HTTP 429 de l'API si on demande "usage" en rafale
let usageCache = { data: null, ts: 0 };
async function recupererUsageAvecCache() {
    if (usageCache.data && Date.now() - usageCache.ts < 60 * 1000) return usageCache.data;
    const usage = await recupererUsageClaude();
    usageCache = { data: usage, ts: Date.now() };
    return usage;
}

function barreProgression(percent) {
    const pleins = Math.max(0, Math.min(10, Math.round(percent / 10)));
    return '█'.repeat(pleins) + '░'.repeat(10 - pleins);
}

// Résumé détaillé façon page "usage" de claude.ai, pour WhatsApp
function resumeUsageComplet(usage) {
    const lignes = ['📊 *Usage Claude*', ''];
    for (const l of usage.limits || []) {
        const libelle = LIBELLES_LIMITES[l.kind] || l.kind;
        const nomModele = l.scope?.model?.display_name;
        lignes.push(`*${nomModele ? `${libelle} — ${nomModele}` : libelle}*`);
        lignes.push(`${barreProgression(l.percent)} ${l.percent}%`);
        lignes.push(`↻ reset ${formaterReset(l.resets_at)}`);
        lignes.push('');
    }
    if (usage.extra_usage?.is_enabled) {
        lignes.push(`💳 Crédits extra : ${usage.extra_usage.utilization ?? 0}%`);
    }
    return lignes.join('\n').trim();
}

verifierLimiteClaude().catch(err => console.error('[claude] Erreur :', err.message));
setInterval(() => {
    verifierLimiteClaude().catch(err => console.error('[claude] Erreur :', err.message));
}, INTERVALLE_VERIF_MS);
