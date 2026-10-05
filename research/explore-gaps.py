# Exploratory gap analysis (keyword themes) over the last 6 months of App Store reviews.
import json, re, collections, sys
d = json.load(open('data/research/app-store-reviews.json'))
R = [r for r in d['reviews'] if r['date'][:10] >= '2026-04-05']
THEMES = {
 'memory/context loss':   r"\b(forget|forgets|forgot|memory|remember|context|reset|resets|lost (my|the) (chat|conversation)|new chat|start over|loses track)\b",
 'usage limits':          r"\b(limit|limits|limited|message cap|cap|quota|usage|run out|ran out|out of messages|wait \d+ hours|hours to|cooldown|rate limit)\b",
 'pricing/billing':       r"\b(price|pricing|expensive|subscription|subscribe|refund|charged|charge|billing|\$\d+|money|pay|paid|pro plan|plus plan|cancel)\b",
 'refusals/over-moderation': r"\b(refus\w*|censor\w*|won't help|wont help|can't help|cannot help|guidelines|policy|violat\w*|restricted|preachy|lectur\w*|moraliz\w*|flagged|inappropriate)\b",
 'accuracy/hallucination': r"\b(wrong|incorrect|hallucinat\w*|made up|makes up|inaccurate|false information|lies|lying|mistake|mistakes|errors in)\b",
 'sources/citations':     r"\b(source|sources|citation|citations|cite|links|references)\b",
 'speed/reliability':     r"\b(slow|lag|laggy|crash\w*|freez\w*|bug|buggy|glitch\w*|error|errors|not working|doesn't work|doesnt work|stuck|loading)\b",
 'image generation':      r"\b(image|images|picture|pictures|photo generation|generate (an )?image|drawing|art)\b",
 'file/photo upload':     r"\b(upload|uploads|attach|attachment|pdf|file|files|document|documents|screenshot)\b",
 'voice':                 r"\b(voice|speak|speaking|talk to|audio|microphone|dictation|read aloud)\b",
 'model choice/quality change': r"\b(model|models|gpt-?\d|opus|sonnet|haiku|claude \d|o\d|dumber|worse than before|downgrade\w*|nerf\w*|used to be better|quality (has )?(dropped|declined))\b",
 'chat organization':     r"\b(folder|folders|organi[sz]\w*|search (my|old|past) (chats|conversations)|history|archive|projects?|pin|rename)\b",
 'account/login':         r"\b(login|log in|sign in|signin|account|verify|verification|phone number|banned|ban|locked out|password)\b",
 'ads/notifications':     r"\b(ads?|advert\w*|notification\w*|spam)\b",
 'support':               r"\b(support|customer service|no response|contact|help desk)\b",
 'export/share':          r"\b(export|share|sharing|copy|download)\b",
 'compare/second opinion': r"\b(compare|comparison|second opinion|switch(ed|ing)? (to|between)|other (ai|apps?|models?)|chatgpt is better|claude is better|gemini|grok|deepseek)\b",
}
REQUEST = r"\b(wish|would be (nice|great|better)|please add|should (add|have|let|allow)|need(s)? (a|an|to be able)|add (a|an|the) (feature|option|way)|missing|no way to|can't even|cannot even|lacks?|i want (it )?to be able|feature request|why can't|why cant|if only)\b"
rows = []
for r in R:
    t = (r['title'] + ' ' + r['text']).lower()
    themes = [k for k, p in THEMES.items() if re.search(p, t)]
    rows.append({**r, 't': t, 'themes': themes, 'request': bool(re.search(REQUEST, t)), 'neg': r['rating'] <= 2})
apps = ['ChatGPT', 'Claude', 'Perplexity']
print('Reviews in window (since 2026-04-05):', {a: sum(1 for x in rows if x['app'] == a) for a in apps})
print('\nShare of NEGATIVE (1-2★) reviews mentioning each theme:')
print(f"{'theme':30}" + ''.join(f'{a:>12}' for a in apps) + '   apps≥8%')
negs = {a: [x for x in rows if x['app'] == a and x['neg']] for a in apps}
scores = []
for th in THEMES:
    vals = [sum(th in x['themes'] for x in negs[a]) / max(1, len(negs[a])) for a in apps]
    scores.append((sum(vals), th, vals))
for s, th, vals in sorted(scores, reverse=True):
    print(f'{th:30}' + ''.join(f'{v*100:11.0f}%' for v in vals) + f'   {sum(v >= 0.08 for v in vals)}')
print('\nNegative counts:', {a: len(negs[a]) for a in apps})
req = [x for x in rows if x['request']]
print('\nExplicit requests ("wish", "please add", "no way to"...):', len(req))
c = collections.Counter(th for x in req for th in x['themes'])
print('  themes in requests:', c.most_common(10))
json.dump([{k: x[k] for k in ('app', 'country', 'rating', 'title', 'text', 'themes', 'request', 'neg')} for x in rows], open('data/research/explore-tagged.json', 'w'))
