"""Python checkpoint reference for Node probability/sequence parity. No network."""
import json
from pathlib import Path
import torch
from laya import Agent
from laya.common import build_sequence

root = Path(__file__).resolve().parent.parent
torch.set_num_threads(4)
torch.set_num_interop_threads(1)
spec = json.loads((root/'work/laya-reference-input.json').read_text(encoding='utf-8'))
agent = Agent(str(root/'work/laya-checkpoint'),device='cpu')
results=[]
for item in spec['cases']:
    question = {'type':'choice','instructions':spec['question'],'criteria':spec['classes']}
    answer=agent.system_one(item['texto'],{'intencao':question})
    results.append({'id':item['id'],'texto':item['texto'],'answer':answer})
    print(item['id'],flush=True)
(root/'work/laya-python-reference.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
