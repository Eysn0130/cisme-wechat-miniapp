"""Complete, hash-bound immutable GitHub responses; mutable CI checks stay live."""
import base64,hashlib,json
from pathlib import PurePosixPath

def need(value):
 if not value:raise ValueError('IMMUTABLE_SOURCE_TRANSPORT_INVALID')
def parse(raw):
 def unique(pairs):
  d={}
  for k,v in pairs:need(k not in d);d[k]=v
  return d
 return json.loads(raw,object_pairs_hook=unique)
def tree_index(raw,expected):
 v=parse(raw);need(v.get('sha')==expected and v.get('truncated')is False and isinstance(v.get('tree'),list))
 entries={};children={'':[]}
 for e in v['tree']:
  p=e.get('path');need(isinstance(p,str)and p and not p.startswith('/')and all(x not in ('','.','..')for x in p.split('/'))and p not in entries)
  need(e.get('mode')in ('040000','100644','100755','120000','160000')and isinstance(e.get('sha'),str)and len(e['sha'])==40)
  need(e.get('type')==('tree'if e['mode']=='040000'else'commit'if e['mode']=='160000'else'blob'))
  entries[p]=e;parent=p.rsplit('/',1)[0]if'/'in p else'';children.setdefault(parent,[]).append(e)
  if e['mode']=='040000':children.setdefault(p,[])
 for directory,rows in sorted(children.items(),key=lambda kv:kv[0].count('/'),reverse=True):
  if directory:need(directory in entries and entries[directory]['mode']=='040000')
  payload=b''
  for e in sorted(rows,key=lambda e:e['path'].rsplit('/',1)[-1].encode()+ (b'/'if e['mode']=='040000'else b'')):
   name=e['path'].rsplit('/',1)[-1].encode();payload+=e['mode'].lstrip('0').encode()+b' '+name+b'\0'+bytes.fromhex(e['sha'])
  digest=hashlib.sha1(b'tree '+str(len(payload)).encode()+b'\0'+payload).hexdigest()
  need(digest==(entries[directory]['sha']if directory else expected))
 return entries

def verified_responses(read,directory,head,tree):
 manifest=parse(read(directory/'cache-manifest.json',65536));need(manifest['sourceHead']==head and manifest['sourceTree']==tree)
 base='https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/'
 allowed={base+'git/trees/'+tree+'?recursive=1': 'tree.json',
          base+'contents/package.json?ref='+head:'package.json.response',
          base+'contents/package-lock.json?ref='+head:'package-lock.json.response'}
 need(set(manifest['responses'])==set(allowed))
 data={}
 for url,name in allowed.items():
  item=manifest['responses'][url];need(item['file']==name);raw=read(directory/name,4*1024**2);need(hashlib.sha256(raw).hexdigest()==item['sha256']);data[url]=raw
 index=tree_index(data[base+'git/trees/'+tree+'?recursive=1'],tree)
 for name in ['package.json','package-lock.json']:
  v=parse(data[base+'contents/'+name+'?ref='+head]);need(v.get('path')==name and v.get('type')=='file'and v.get('encoding')=='base64')
  raw=base64.b64decode(v['content'].replace('\n','').replace('\r',''),validate=True)
  need(len(raw)==v['size']and hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==v['sha']==index[name]['sha'])
 return data,{'treeSha':tree,'treeReconstructed':True,'immutableResponseCount':len(data),'manifestSha256':hashlib.sha256(read(directory/'cache-manifest.json',65536)).hexdigest()}

def install(helper,directory,head,tree):
 data,proof=verified_responses(helper.protected,directory,head,tree)
 original=helper.H.response;stats={'immutableCacheReads':0,'liveReads':0}
 def response(url,limit):
  if url in data:
   need(len(data[url])<=limit);stats['immutableCacheReads']+=1;return data[url]
  stats['liveReads']+=1;return original(url,limit)
 helper.H.response=response
 return lambda:setattr(helper.H,'response',original),{**proof,'requests':stats}
