import dgram from 'dgram';
import os from 'os';
import { getDeviceIdentity } from '../device';

const PORT = 45454;
const GROUP = '239.255.42.99';
let socket: any = null;
const peers = new Map<string, any>();

export function startLanDiscovery(apiPort:number) {
  if (socket) return;
  socket = dgram.createSocket({ type:'udp4', reuseAddr:true });
  const identity = getDeviceIdentity();
  socket.on('message',(msg,rinfo)=>{
    try {
      const data=JSON.parse(msg.toString());
      if(data.type!=='bmax-hello' && data.type!=='bmax-peer') return;
      if(data.deviceId===identity.deviceId) return;
      peers.set(data.deviceId,{deviceId:data.deviceId,deviceName:data.deviceName||rinfo.address,hostname:data.hostname||rinfo.address,host:rinfo.address,port:Number(data.port)||apiPort,version:data.version||1,lastSeenAt:new Date().toISOString()});
      if(data.type==='bmax-hello'){
        const reply=Buffer.from(JSON.stringify({type:'bmax-peer',deviceId:identity.deviceId,deviceName:identity.deviceName,port:apiPort,version:1}));
        socket!.send(reply,0,reply.length,rinfo.port,rinfo.address);
      }
    } catch (_) {}
  });
  socket.bind(PORT,()=>{ try { socket!.addMembership(GROUP); socket!.setBroadcast(true); } catch (_) {} });
  const advertise=()=>{
    if(!socket)return;
    const msg=Buffer.from(JSON.stringify({type:'bmax-hello',deviceId:identity.deviceId,deviceName:identity.deviceName,port:apiPort,hostname:os.hostname(),version:1}));
    socket.send(msg,0,msg.length,PORT,GROUP);
    const cutoff=Date.now()-45000; for(const [id,p] of peers) if(Date.parse(p.lastSeenAt)<cutoff) peers.delete(id);
  };
  advertise();
  const timer:any=setInterval(advertise,15000); timer?.unref?.();
}

export function getLanPeers(){ return Array.from(peers.values()); }



