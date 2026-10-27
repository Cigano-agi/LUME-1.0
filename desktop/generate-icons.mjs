import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
const svg=readFileSync('desktop/icon.svg');
const png=await sharp(svg).png().toBuffer();writeFileSync('desktop/icon.png',png);
const icoPng=await sharp(svg).resize(256,256).png().toBuffer();
const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(icoPng.length,14);ico.writeUInt32LE(22,18);
writeFileSync('desktop/icon.ico',Buffer.concat([ico,icoPng]));
const chunks=[];
for(const [type,size] of [['ic07',128],['ic08',256],['ic09',512],['ic10',1024]]){
 const data=await sharp(svg).resize(size,size).png().toBuffer(),header=Buffer.alloc(8);header.write(type);header.writeUInt32BE(data.length+8,4);chunks.push(header,data);
}
const head=Buffer.alloc(8);head.write('icns');head.writeUInt32BE(8+chunks.reduce((s,b)=>s+b.length,0),4);
writeFileSync('desktop/icon.icns',Buffer.concat([head,...chunks]));
console.log('Icones PNG/ICO/ICNS gerados do SVG original.');
