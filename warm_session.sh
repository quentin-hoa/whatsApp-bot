#!/bin/bash
PROMPT=$(cat << 'EOF'
Agis comme un analyste financier senior spécialisé dans les crypto-actifs. Rédige-moi un brief quotidien précis, concis et actionnable sur l'état du marché des cryptomonnaies aujourd'hui. 

Pour la recherche d'informations, concentre-toi uniquement sur les actualités et les données des dernières 24 heures.

Structure ton rapport exactement selon le plan suivant, en utilisant des puces (bullet points) pour faciliter la lecture :

### 1. Vue d'ensemble du marché (Général)
- Sentiment général du marché (Fear & Greed Index si disponible).
- Performance globale des capitalisations et tendance du jour.
- Les 2 ou 3 actualités majeures qui dictent la direction du marché aujourd'hui.

### 2. Analyse Macro-économique
- Données macro (taux de la Fed, inflation, chiffres de l'emploi, décisions réglementaires) ayant un impact direct sur les actifs à risque et les cryptos aujourd'hui.
- Corrélation ou comportement des marchés traditionnels (S&P500, DXY/Dollar, Or) face aux cryptos.

### 3. Le Point sur les ETF (Bitcoin & Ethereum)
- Flux entrants/sortants (Inflows/Outflows) des ETF Spot Bitcoin et Ethereum des dernières 24-48h.
- Actualités réglementaires ou institutionnelles majeures concernant les ETF.

### 4. Focus Portefeuille (Altcoins)
Analyse brièvement l'actualité spécifique (mises à jour techniques, partenariats, narratifs) et l'action des prix (support/résistance clés ou performances du jour) pour la liste de jetons ci-dessous (à personnaliser avec ton propre portefeuille) :
- Ethereum (ETH)
- Solana (SOL)
- Bitcoin (BTC)

Reste factuel, évite le jargon inutile et va droit au but. Pas d'introduction polie, commence directement par la section 1.
Pas la peine de mettre des sources.
EOF
)
OUTPUT_DIR="$HOME/crypto_briefs"
mkdir -p "$OUTPUT_DIR"
DATE=$(date +%Y-%m-%d)
BRIEF_FILE="$OUTPUT_DIR/Brief_$DATE.md"
"$HOME/.local/bin/claude" --model claude-haiku-4-5 -p "$PROMPT" > "$BRIEF_FILE"

# Nettoyage markdown -> format WhatsApp (le .md brut reste archivé tel quel)
# **gras** -> *gras*, ### Titre -> *Titre*, - puce -> • puce
# Coupe tout à partir de la section Sources (Claude l'ajoute malgré la consigne)
WHATSAPP_TEXT=$(sed -E \
  -e '/^#{1,6}[[:space:]]*Sources:?[[:space:]]*$/,$d' \
  -e '/^\*{0,2}Sources:?\*{0,2}[[:space:]]*$/,$d' \
  "$BRIEF_FILE" | sed -E \
  -e 's/\*\*([^*]+)\*\*/*\1*/g' \
  -e 's/^#{1,6}[[:space:]]+(.*)$/*\1*/' \
  -e 's/^- /• /')

# Envoi WhatsApp via bot.js (doit déjà tourner sur le Pi, port 3001)
echo "$WHATSAPP_TEXT" | jq -Rs '{message: .}' \
  | curl -s -X POST -H "Content-Type: application/json" -d @- http://localhost:3001/send-text
