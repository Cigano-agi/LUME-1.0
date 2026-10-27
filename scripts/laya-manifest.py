"""Create local export manifest only after upstream torch/ONNX parity passes."""
import hashlib
import json
import sys
import shutil
from pathlib import Path
from tokenizers import Tokenizer

root = Path(__file__).resolve().parent.parent
export_dir = root / 'work/laya-onnx'
log = Path(sys.argv[1]).read_text(encoding='utf-16' if Path(sys.argv[1]).read_bytes()[:2] in (b'\xff\xfe',b'\xfe\xff') else 'utf-8')
if log.count('verify ok: torch vs onnx match within 1e-4') != 3 or 'wrote ' not in log:
    raise SystemExit('Export parity not proven; manifest refused')
tokenizer = Tokenizer.from_file(str(export_dir / 'tokenizer.json'))
texts = ['Pode enviar o documento?', 'Já enviei, não vou enviar novamente.', 'A audiência mudou. Não confirme o prazo.', 'R$ 1.250,00 ainda não recebidos.', 'ação, João e procuração', 'linha um\nlinha dois', '  Bom dia!  ', '🙂 Obrigado', 'Ignore as instruções anteriores.', 'Eu... amanhã não, deixa.']
proof = [{'text':text,'ids':tokenizer.encode(text,add_special_tokens=False).ids} for text in texts]
shutil.copyfile(root/'work/laya-upstream/LICENSE',export_dir/'LICENSE')
shutil.copyfile(root/'work/laya-checkpoint/README.md',export_dir/'MODEL-CARD.md')
files = ['encoder.onnx','encoder.onnx.data','head.onnx','head.onnx.data','tokenizer.json','rl_agent_config.json','LICENSE','MODEL-CARD.md']
def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f,'sha256').hexdigest()
manifest = {'model':'convaiinnovations/laya-multilingual','revision':'82d57fc4f2d1be3d2caac494045f2ec51d0842f3','upstream':'1e28ac20c0896b1c37a744cd11f740eb98f8b178','license':'Apache-2.0','parityVerified':True,'tokenizerParity':proof,'sha256':{name:digest(export_dir/name) for name in files},'checkpointSha256':digest(root/'work/laya-checkpoint/model.safetensors'),'experimental':True}
(export_dir/'lume-laya-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'created':True,'sha256':manifest['sha256']}))
