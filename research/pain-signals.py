# Pain-signal analysis over substantive negative App Store reviews (1-2 stars, 15+ words, last 6 months).
# Keyword matching, so treat results as directional. A review can match several signals.
#   python3 research/pain-signals.py [path-to-reviews.json] [since YYYY-MM-DD]
import json, re, sys, math
path = sys.argv[1] if len(sys.argv) > 1 else 'data/research/app-store-reviews.json'
since = sys.argv[2] if len(sys.argv) > 2 else '2026-04-05'
d = json.load(open(path))
apps = ['ChatGPT', 'Claude', 'Perplexity']
SIG = {
 'Usage/cost unpredictable (limits, credits, ran out)': r"\b(credits?|tokens?|allowance|usage (meter|limit|cap)|ran out|run out|burn(ed|t|s)? through|5[- ]hours?|five hours|weekly limit|limit reached|hit (the|my) limit|wait (5|five) hours|out of messages|message limit|need more credits|limits?)\b",
 'Wrong or made-up answers': r"\b(wrong|incorrect|hallucinat\w*|made up|makes (things |stuff )?up|inaccurate|false (info|information)|lies|lying|fabricat\w*)\b",
 'Quality got worse after an update': r"(used to be|since the (latest |recent |new )?update|after the (latest |recent |new )?update|got worse|getting worse|worse than before|degrad|not as good as (before|it used)|downgrad|nerf|dumber|went downhill|going downhill|since (february|march|april|may|june|july|august|september))",
 'Switching/cancelling to another AI': r"\b(switch(ed|ing)? to|moving to|moved to|going back to|cancel(l)?(ed|ing)?|uninstall(ed|ing)?|unsubscrib\w*|goodbye)\b",
 'Fails silently / stuck / no answer': r"(stops? (responding|working|mid)|no (error|response|answer)|never (finish|finishes|completes|answers)|doesn'?t (finish|complete|answer|respond)|stuck|spinning|nothing happens|just stops|cuts? off|not (answering|responding))",
 'Refuses or moralizes': r"(refus\w*|censor\w*|won'?t (help|answer|do)|can'?t help with|guidelines|policy|preachy|lectur\w*|moraliz\w*|safety (filter|system)|flagged)",
 'Files/PDFs/images fail': r"\b(pdfs?|upload\w*|attach\w*|re-?upload|can'?t (read|see) (the |my )?(file|pdf|document)|image|images|picture|pictures)\b",
 'Ignores instructions / forgets context': r"(ignor(es|ed|ing)|doesn'?t listen|does not listen|won'?t listen|keeps? (repeating|doing the same)|repeats?|forget\w*|forgot|memory|context|confus\w*|reset\w*)",
 'Mentions a competitor by name': r"\b(chatgpt|chat gpt|claude|gemini|grok|perplexity|deepseek|copilot)\b",
}
text = lambda x: (x['title'] + ' ' + x['text']).lower()
rows = [r for r in d['reviews'] if r['date'][:10] >= since]
neg = {a: [x for x in rows if x['app'] == a and x['rating'] <= 2 and len(text(x).split()) >= 15] for a in apps}
tot = sum(len(v) for v in neg.values())
print(f"Source: {d.get('source')} | countries: {', '.join(d.get('countries', []))} | fetched {(d.get('fetched_at') or d.get('updated_at') or '')[:10]}")
print(f"All reviews: {len(d['reviews'])} | in window since {since}: {len(rows)}")
print("Substantive negative reviews (1-2 stars, 15+ words): " + ', '.join(f"{a} {len(neg[a])}" for a in apps) + f" = {tot}\n")
print(f"{'pain signal':52}" + ''.join(f'{a:>11}' for a in apps) + '     all   95% range')
res = []
for name, p in SIG.items():
    vals = []
    for a in apps:
        n = 0
        for x in neg[a]:
            t = text(x)
            if name.startswith('Mentions'): t = t.replace(a.lower(), '')  # own name doesn't count
            if re.search(p, t): n += 1
        vals.append(n)
    res.append((sum(vals), name, vals))
for s, name, vals in sorted(res, reverse=True):
    pr = s / tot; moe = 1.96 * math.sqrt(pr * (1 - pr) / tot)
    print(f"{name:52}" + ''.join(f'{v/max(1,len(neg[a]))*100:10.0f}%' for v, a in zip(vals, apps)) + f"  {pr*100:5.0f}%   {max(0,pr-moe)*100:.0f}-{(pr+moe)*100:.0f}%")
churn = SIG['Switching/cancelling to another AI']
ch = [x for a in apps for x in neg[a] if re.search(churn, text(x))]
print(f"\nAmong {len(ch)} reviews that mention switching or cancelling, share that also mention:")
for name, p in SIG.items():
    if name.startswith(('Switching', 'Mentions')): continue
    n = sum(1 for x in ch if re.search(p, text(x)))
    print(f"  {name:52} {n/max(1,len(ch))*100:4.0f}%  ({n}/{len(ch)})")
