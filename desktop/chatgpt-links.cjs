function linkChatGPTPermitido(raw) {
  try {
    const u=new URL(raw);
    if(u.username||u.password||u.hash||u.protocol!=='https:')return false;
    if(u.href==='https://chatgpt.com/settings/usage')return true;
    if(u.origin!=='https://auth.openai.com'||u.pathname!=='/api/accounts/authorize')return false;
    const p=u.searchParams,r=new URL(p.get('redirect_uri'));
    return (p.get('client_id')==='dynamic_agent_client'||/^oaiapp_[\w-]+$/.test(p.get('client_id')||''))&&
      p.get('response_type')==='code'&&p.get('code_challenge_method')==='S256'&&
      /^[\w-]{43}$/.test(p.get('code_challenge')||'')&&/^[\w-]{43}$/.test(p.get('state')||'')&&
      r.protocol==='http:'&&r.hostname==='127.0.0.1'&&!!r.port&&r.pathname==='/auth/callback'&&
      !r.username&&!r.password&&!r.search&&!r.hash;
  }catch{return false;}
}
module.exports={linkChatGPTPermitido};
