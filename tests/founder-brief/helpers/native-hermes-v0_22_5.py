#!/usr/bin/env python3
# Offline native-CLI fixture only. It cannot contact GitHub, Telegram or Hermes.
import argparse,json,os,pathlib,sys
args=sys.argv[1:];home=pathlib.Path(os.environ["HERMES_HOME"])
log=home/"fixture-argv.jsonl"
with log.open("a") as out: out.write(json.dumps(args)+"\n")
if args==["--profile","default","--version"]:
 print("Hermes Agent v"+os.environ.get("BRIEF_VERSION","0.22.5"));sys.exit()
if args[:2]!=["--profile","default"]: sys.exit(90)
args=args[2:]
if args[:2]==["gateway","ensure"]:
 commit=os.environ.get("BRIEF_COMMIT","bf0203a794a07aac3ff764972ab9087baa4e4f4e")
 print(json.dumps({"state":"ready","client_code_sha":commit,"endpoint":{"profile_id":str(home),"control_home":None,"supervisor":"systemd","runtime_protocol":1,"authority_epoch":1,"instance_id":"offline-fixture","code_sha":commit}}));sys.exit()
if args[:1]!=["cron"]: sys.exit(91)
store=home/"cron/jobs.json";data=json.loads(store.read_text()) if store.exists() else {"jobs":[]}
mode=os.environ.get("BRIEF_FAIL","")
if args[1]=="create":
 if mode=="create_before": sys.exit(1)
 parser=argparse.ArgumentParser();parser.add_argument("schedule");parser.add_argument("prompt",nargs="?")
 for key in ("name","deliver","failure-deliver","script"):parser.add_argument("--"+key)
 parser.add_argument("--no-agent",action="store_true");a=vars(parser.parse_args(args[2:]))
 job={"id":"created-"+str(len(data["jobs"])+1),"name":a["name"],"prompt":a["prompt"].strip(),"schedule":{"kind":"cron","expr":a["schedule"]},"repeat":{"times":None,"completed":0},"skills":[],"no_agent":a["no_agent"],"script":a["script"],"deliver":a["deliver"],"failure_deliver":a["failure_deliver"],"enabled":True,"state":"scheduled"}
 data["jobs"].append(job)
elif args[1]=="remove":
 if mode=="remove_before":sys.exit(1)
 data["jobs"]=[job for job in data["jobs"] if job["id"]!=args[2]]
else:sys.exit(92)
store.parent.mkdir(exist_ok=True);store.write_text(json.dumps(data))
if mode==args[1]+"_after":sys.exit(1)
