type OperatorContext={api:string;token:string};
/** Keep credentials only in request memory. A late result from an earlier
 * operator/environment may not render or trigger a personal-data download. */
export async function inOperatorContext<T>(read:()=>OperatorContext,task:(context:OperatorContext)=>Promise<T>):Promise<T>{
  const context={...read()};
  if(!context.api||!context.token)throw Error('请先填写当前已验证操作员会话和 API 地址。');
  const result=await task(context),current=read();
  if(current.api!==context.api||current.token!==context.token)throw Error('操作员会话或环境已改变，请在当前身份下重新查询。');
  return result;
}
