"""Developer-only wrapper for upstream ONNX exporter on pinned Torch 2.9 CPU.

Usage: python scripts/laya-export.py --model-dir work/laya-checkpoint --out-dir work/laya-onnx
The upstream 0.3.11 exporter assumes Torch 2.9's dynamo default. Keep it explicit.
"""
import runpy
import sys
import os
from pathlib import Path
import torch

torch.set_num_threads(4)
torch.set_num_interop_threads(1)
original = torch.onnx.export
def export(*args, **kwargs):
    if os.environ.get('LAYA_REUSE_ENCODER') == '1' and Path(args[2]).name == 'encoder.onnx' and Path(args[2]).exists():
        print('Reusing encoder for head-only repair; final torch/ONNX parity remains mandatory',flush=True)
        return
    # Upstream reference tensors come from inference_mode; capture needs
    # ordinary tensors even though this is an eval-only model.
    args = (args[0], tuple(value.clone() if isinstance(value,torch.Tensor) else value for value in args[1]), *args[2:])
    kwargs['dynamo'] = True
    # Lume is single-flight: static batch=1, dynamic sequence/marker count.
    sequence = torch.export.Dim('seq',min=2,max=8192)
    kwargs['dynamic_shapes'] = tuple({axis: sequence if axis == 1 and index in (0,len(kwargs['dynamic_shapes'])-1) else dim for axis, dim in shape.items() if axis != 0} for index,shape in enumerate(kwargs['dynamic_shapes']))
    kwargs['dynamic_axes'] = {name:{axis:dim for axis,dim in axes.items() if axis != 0} for name,axes in kwargs['dynamic_axes'].items()}
    return original(*args, **kwargs)
torch.onnx.export = export
root = Path(__file__).resolve().parent.parent
source_path = root / 'work/laya-upstream/laya-ts/scripts/export_onnx.py'
source = source_path.read_text(encoding='utf-8')
source = source.replace('(2, seq', '(1, seq').replace('(2, int(args.verify_len)', '(1, int(args.verify_len)').replace('batch=2', 'batch=1')
exec(compile(source,str(source_path),'exec'),{'__name__':'__main__','__file__':str(source_path)})
