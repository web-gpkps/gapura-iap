Deno.serve(async (request) => {
 if(request.method!=="POST")return new Response("Method not allowed",{status:405});
 const url=Deno.env.get("SUPABASE_URL")!+"/rest/v1/rpc/";
 const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
 const headers={apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json"};
 const token=request.headers.get("x-iap-server-token")??"";
 if(!token) return new Response("Unauthorized",{status:401});
 try {
  const auth=await fetch(url+"iap_server_authorized",{method:"POST",headers,
   body:JSON.stringify({p_token:token}),signal:AbortSignal.timeout(10_000)});
  if(!auth.ok||await auth.json()!==true)return new Response("Unauthorized",{status:401});
  const text=await request.text();
  if(new TextEncoder().encode(text).length>1_000_000)return new Response("Payload too large",{status:413});
  const {name,payload}=JSON.parse(text);
  if(!["iap_snapshot","iap_snapshot_since","iap_mutate"].includes(name))return new Response("Forbidden RPC",{status:403});
  if(!payload||typeof payload!=="object"||Array.isArray(payload))return new Response("Invalid payload",{status:400});
  const response=await fetch(url+name,{method:"POST",headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(20_000)});
  // Forward DB errors without headers or service credentials.
  return new Response(await response.text(),{status:response.status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
 } catch(error) {
  console.error(error instanceof Error?error.message:"Gateway failed");
  return Response.json({message:"Server database gateway gagal."},{status:500});
 }
});
