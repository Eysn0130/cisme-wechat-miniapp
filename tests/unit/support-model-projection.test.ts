import {describe,expect,it} from "vitest";
import {modelSafeSupportProjection} from "../../services/api/src/supportService";
describe("support model-safe projection",()=>{
 it("never forwards member, phone, address, care or attachment objects",()=>{
  const projection=modelSafeSupportProjection({conversation:{id:"00000000-0000-0000-0000-000000000001",member_id:"secret-member",status:"ai_active",priority:"normal",current_handler_principal_id:null,next_sequence:"2",member_unread_count:0,team_unread_count:1,member_last_read_sequence:"0",team_last_read_sequence:"0",version:1,updated_at:new Date("2026-09-11T00:00:00Z")},messages:[{id:"message",sequence:"1",sender_type:"user",body:"我的订单发货了吗？",attachment_refs:["private-object"],delivery_state:"persisted",created_at:new Date()}]});
  expect(projection).toEqual({conversationId:"00000000-0000-0000-0000-000000000001",status:"ai_active",messages:[{sequence:1,senderType:"user",body:"我的订单发货了吗？"}]});
  expect(JSON.stringify(projection)).not.toMatch(/secret-member|private-object|phone|address|care/i);
 });
});
