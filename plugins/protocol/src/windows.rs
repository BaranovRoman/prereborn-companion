//! Atomic job-list spawn: no runnable or suspended worker exists outside its job.
//! Only owned kernel handles / a generation-named job are termination evidence.
use std::{ffi::OsStr, fs::File, io, mem::size_of, os::windows::{ffi::OsStrExt, io::{FromRawHandle, OwnedHandle, AsRawHandle}, process::ExitStatusExt}, process::{Command, ExitStatus}, ptr, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::*, Security::SECURITY_ATTRIBUTES, System::{JobObjects::*, Pipes::CreatePipe, Threading::*, SystemServices::{JOB_OBJECT_QUERY,JOB_OBJECT_TERMINATE}}};
use windows_sys::Win32::System::SystemInformation::GetSystemWindowsDirectoryW;

// Winsock providers may expand %SystemRoot% when loading their native DLL.
// An entirely empty environment yielded WSAEPROVIDERFAILEDINIT (10106) in the
// actual supervised worker. Supply only this OS-derived value, never the
// caller's PATH, account tokens, signing secrets, proxies or profile variables.
fn environment()->io::Result<Vec<u16>>{unsafe{
    let mut root=vec![0u16;32768];let count=GetSystemWindowsDirectoryW(root.as_mut_ptr(),root.len() as u32) as usize;
    if count==0{return Err(io::Error::last_os_error());}
    if count>=root.len(){return Err(io::Error::new(io::ErrorKind::InvalidData,"system directory too long"));}
    root.truncate(count);let mut env:Vec<u16>="SystemRoot=".encode_utf16().collect();env.extend(root);env.extend([0,0]);Ok(env)
}}

fn wide(s: &OsStr) -> io::Result<Vec<u16>> {
    let mut v:Vec<_>=s.encode_wide().collect();
    if v.contains(&0){return Err(io::Error::new(io::ErrorKind::InvalidInput,"NUL in process argument"));}
    v.push(0);Ok(v)
}
// Microsoft CRT quoting, including trailing backslashes and embedded quotes.
fn quote(s:&OsStr)->io::Result<Vec<u16>> {
    let units=wide(s)?;let mut out=vec![34];let mut slashes=0;
    for &c in &units[..units.len()-1] {
        if c==92 {slashes+=1;continue;}
        out.extend(std::iter::repeat_n(92,if c==34 {slashes*2+1}else{slashes}));slashes=0;out.push(c);
    }
    out.extend(std::iter::repeat_n(92,slashes*2));out.push(34);Ok(out)
}
fn name(generation:&str)->io::Result<Vec<u16>> {
    let id=uuid::Uuid::parse_str(generation).map_err(|_|io::Error::new(io::ErrorKind::InvalidInput,"invalid generation"))?;
    wide(OsStr::new(&format!("Local\\Prereborn.Plugin.{}",id)))
}
unsafe fn own(handle:HANDLE)->io::Result<OwnedHandle> {
    if handle.is_null()||handle==INVALID_HANDLE_VALUE {Err(io::Error::last_os_error())}
    else {Ok(OwnedHandle::from_raw_handle(handle))}
}
fn pipe(parent_reads:bool)->io::Result<(File,OwnedHandle)> {unsafe {
    let sa=SECURITY_ATTRIBUTES{nLength:size_of::<SECURITY_ATTRIBUTES>() as u32,lpSecurityDescriptor:ptr::null_mut(),bInheritHandle:1};
    let(mut r,mut w)=(ptr::null_mut(),ptr::null_mut());
    if CreatePipe(&mut r,&mut w,&sa,0)==0{return Err(io::Error::last_os_error());}
    let r=own(r)?;let w=own(w)?;let(parent,child)=if parent_reads{(r,w)}else{(w,r)};
    if SetHandleInformation(parent.as_raw_handle(),HANDLE_FLAG_INHERIT,0)==0{return Err(io::Error::last_os_error());}
    Ok((File::from(parent),child))
}}
struct Attributes { storage:Vec<usize> }
impl Attributes {
    fn new()->io::Result<Self>{unsafe {
        let mut bytes=0;InitializeProcThreadAttributeList(ptr::null_mut(),2,0,&mut bytes);
        if bytes==0{return Err(io::Error::last_os_error());}
        let mut storage=vec![0usize;bytes.div_ceil(size_of::<usize>())];
        if InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(),2,0,&mut bytes)==0{return Err(io::Error::last_os_error());}Ok(Self{storage})
    }}
    fn ptr(&mut self)->LPPROC_THREAD_ATTRIBUTE_LIST{self.storage.as_mut_ptr().cast()}
    fn set(&mut self,key:u32,handles:&[HANDLE])->io::Result<()>{unsafe {
        if UpdateProcThreadAttribute(self.ptr(),0,key as usize,handles.as_ptr().cast(),size_of_val(handles),ptr::null_mut(),ptr::null())==0 {Err(io::Error::last_os_error())}else{Ok(())}
    }}
}
impl Drop for Attributes {fn drop(&mut self){unsafe{DeleteProcThreadAttributeList(self.ptr());}}}

pub struct Child {
    process:OwnedHandle, job:OwnedHandle, pid:u32, initial:Option<Fence>, termination:Option<Fence>,
    pub stdin:Option<File>,pub stdout:Option<File>,pub stderr:Option<File>,
}
impl Child {
    pub fn id(&self)->u32{self.pid}
    pub fn kill(&mut self)->io::Result<()>{unsafe {
        // Capture handles before termination removes PIDs from job accounting.
        let witness=capture(self.job.as_raw_handle());
        if TerminateJobObject(self.job.as_raw_handle(),1)==0{return Err(io::Error::last_os_error());}
        match witness {Ok(mut w)=>{
            if self.termination.is_none() {
                if let Some(initial)=self.initial.as_mut() {
                    if initial.handles.len()+w.handles.len()>256{return Err(io::Error::other("fence handle quota exhausted"));}
                    w.handles.append(&mut initial.handles);
                }
            }
            if let Some(old)=self.termination.as_mut() {
                if old.total==w.total{return Ok(());} // Existing handles cover the same membership.
                if old.handles.len()+w.handles.len()>256{return Err(io::Error::other("fence handle quota exhausted"));}
                w.handles.append(&mut old.handles);
            }
            self.termination=Some(w);Ok(())
        },Err(e)=>Err(e)}
    }}
    pub fn try_wait(&mut self)->io::Result<Option<ExitStatus>>{unsafe {
        match WaitForSingleObject(self.process.as_raw_handle(),0) {
            WAIT_TIMEOUT=>Ok(None),WAIT_OBJECT_0=>{
                // Root exit alone is insufficient: a descendant may still own an IPC pipe.
                let info=accounting(self.job.as_raw_handle())?;
                if info.ActiveProcesses!=0{return Ok(None);}
                let witness=self.termination.as_ref().or(self.initial.as_ref())
                    .ok_or_else(||io::Error::other("job exit unproven"))?;
                if !witness.complete(self.job.as_raw_handle())?{return Ok(None);}
                let mut code=0;if GetExitCodeProcess(self.process.as_raw_handle(),&mut code)==0{return Err(io::Error::last_os_error());}
                Ok(Some(ExitStatus::from_raw(code)))
            },_=>Err(io::Error::last_os_error()),
        }
    }}
}
fn accounting(job:HANDLE)->io::Result<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>{unsafe {
    let mut info=JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    if QueryInformationJobObject(job,JobObjectBasicAccountingInformation,(&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),size_of_val(&info) as u32,ptr::null_mut())==0{return Err(io::Error::last_os_error());}Ok(info)
}}
// Bounded kernel-handle witness; PID lookup alone never proves identity or completion.
struct Fence { handles:Vec<OwnedHandle>,total:u32 }
impl Fence {
    fn complete(&self,job:HANDLE)->io::Result<bool>{unsafe {
        let info=accounting(job)?;
        if info.TotalProcesses!=self.total{return Err(io::Error::other("job membership changed while fencing"));}
        for handle in &self.handles {
            match WaitForSingleObject(handle.as_raw_handle(),0) {
                WAIT_OBJECT_0=>(),WAIT_TIMEOUT=>return Ok(false),_=>return Err(io::Error::last_os_error()),
            }
        }
        Ok(info.ActiveProcesses==0)
    }}
}
fn capture(job:HANDLE)->io::Result<Fence>{unsafe {
    const MAX_PROCESSES:usize=256;
    let total=accounting(job)?.TotalProcesses;
    let bytes=size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()+MAX_PROCESSES*size_of::<usize>();
    let mut storage=vec![0usize;bytes.div_ceil(size_of::<usize>())];
    if QueryInformationJobObject(job,JobObjectBasicProcessIdList,storage.as_mut_ptr().cast(),bytes as u32,ptr::null_mut())==0{return Err(io::Error::last_os_error());}
    let list=storage.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
    let count=(*list).NumberOfProcessIdsInList as usize;
    if count==0||count>MAX_PROCESSES||(*list).NumberOfAssignedProcesses as usize!=count{return Err(io::Error::other("job membership unproven"));}
    let ids=std::slice::from_raw_parts(ptr::addr_of!((*list).ProcessIdList).cast::<usize>(),count);
    let mut handles=Vec::with_capacity(count);
    for &pid in ids {
        let pid=u32::try_from(pid).map_err(|_|io::Error::other("invalid job process id"))?;
        let handle=own(OpenProcess(PROCESS_SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,0,pid))?;
        let mut member=0;
        if IsProcessInJob(handle.as_raw_handle(),job,&mut member)==0||member==0{return Err(io::Error::other("job process identity unproven"));}
        handles.push(handle);
    }
    if accounting(job)?.TotalProcesses!=total{return Err(io::Error::other("job membership changed"));}
    Ok(Fence{handles,total})
}}
pub fn spawn(command:&Command,generation:&str)->io::Result<Child>{unsafe {
    let job_name=name(generation)?;
    let raw=CreateJobObjectW(ptr::null(),job_name.as_ptr());let error=GetLastError();let job=own(raw)?;
    if error==ERROR_ALREADY_EXISTS{return Err(io::Error::new(io::ErrorKind::AlreadyExists,"generation job already exists"));}
    let mut limits=JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if SetInformationJobObject(job.as_raw_handle(),JobObjectExtendedLimitInformation,(&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),size_of_val(&limits) as u32)==0{return Err(io::Error::last_os_error());}
    let(stdin,in_child)=pipe(false)?;let(stdout,out_child)=pipe(true)?;let(stderr,err_child)=pipe(true)?;
    let handles=[in_child.as_raw_handle(),out_child.as_raw_handle(),err_child.as_raw_handle()];let jobs=[job.as_raw_handle()];
    let mut attrs=Attributes::new()?;attrs.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST,&handles)?;attrs.set(PROC_THREAD_ATTRIBUTE_JOB_LIST,&jobs)?;
    let mut startup=STARTUPINFOEXW::default();startup.StartupInfo.cb=size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=handles[0];startup.StartupInfo.hStdOutput=handles[1];startup.StartupInfo.hStdError=handles[2];startup.lpAttributeList=attrs.ptr();
    let program=wide(command.get_program())?;let mut line=quote(command.get_program())?;
    for arg in command.get_args(){line.push(32);line.extend(quote(arg)?);}line.push(0);
    let cwd=command.get_current_dir().map(|p|wide(p.as_os_str())).transpose()?;
    let env=environment()?;let mut pi=PROCESS_INFORMATION::default();
    if CreateProcessW(program.as_ptr(),line.as_mut_ptr(),ptr::null(),ptr::null(),1,EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,env.as_ptr().cast(),cwd.as_ref().map_or(ptr::null(),|x|x.as_ptr()),&startup.StartupInfo,&mut pi)==0{return Err(io::Error::last_os_error());}
    let process=own(pi.hProcess)?;let _thread=own(pi.hThread)?;
    // Capture actual membership/counter instead of assuming a new job reports TotalProcesses=1.
    let initial=capture(job.as_raw_handle()).ok();
    Ok(Child{process,job,pid:pi.dwProcessId,initial,termination:None,stdin:Some(stdin),stdout:Some(stdout),stderr:Some(stderr)})
}}
/// The worker must prove membership in its exact generation job before opening
/// live ingestion. A PID, command-line UUID or inherited parent job is insufficient.
pub fn verify_current_generation(generation:&str)->Result<(),String>{unsafe {
    let n=name(generation).map_err(|_|"invalid_process_generation")?;
    let job=own(OpenJobObjectW(JOB_OBJECT_QUERY,0,n.as_ptr())).map_err(|_|"process_supervision_unproven")?;
    let mut member=0;
    if IsProcessInJob(GetCurrentProcess(),job.as_raw_handle(),&mut member)==0||member==0{return Err("process_supervision_unproven".into());}
    Ok(())
}}
// Explicit recovery only. Never called from normal bootstrap. No saved-PID lookup or kill by PID.
pub fn fence_generation(generation:&str)->Result<(),String>{unsafe {
    let n=name(generation).map_err(|_|"invalid_process_generation")?;
    let raw=OpenJobObjectW(JOB_OBJECT_QUERY|JOB_OBJECT_TERMINATE,0,n.as_ptr());
    if raw.is_null(){return if GetLastError()==ERROR_FILE_NOT_FOUND {Ok(())}else{Err("process_fence_unproven".into())};}
    let job=own(raw).map_err(|_|"process_fence_unproven")?;
    let witness=capture(job.as_raw_handle()).map_err(|_|"process_fence_unproven")?;
    if TerminateJobObject(job.as_raw_handle(),1)==0{return Err("process_fence_unproven".into());}
    let deadline=Instant::now()+Duration::from_secs(2);
    loop {if witness.complete(job.as_raw_handle()).map_err(|_|"process_fence_unproven")?{return Ok(());}
        if Instant::now()>=deadline{return Err("process_fence_unproven".into());}std::thread::sleep(Duration::from_millis(5));}
}}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn quoting_preserves_trailing_slashes_and_quotes(){assert_eq!(quote(OsStr::new("a\\\"b\\")).unwrap(),"\"a\\\\\\\"b\\\\\"".encode_utf16().collect::<Vec<_>>());}
    fn worker(generation:&str,tree:bool)->Child {
        use std::io::BufRead;
        let fixture=format!("{}::{}",module_path!().split_once("::").unwrap().1,if tree{"tree_fixture"}else{"worker_fixture"});
        let mut command=Command::new(std::env::current_exe().unwrap());command.args(["--ignored","--exact",&fixture,"--nocapture"]);
        let mut child=spawn(&command,generation).unwrap();let mut reader=std::io::BufReader::new(child.stdout.take().unwrap());
        loop {let mut line=String::new();assert!(reader.read_line(&mut line).unwrap()>0);if line.contains("WORKER_READY"){break;}}
        child
    }
    fn wait_exit(child:&mut Child) {
        let deadline=Instant::now()+Duration::from_secs(2);
        loop {if child.try_wait().unwrap().is_some(){return;}assert!(Instant::now()<deadline,"owned kernel handle did not signal exit");std::thread::sleep(Duration::from_millis(5));}
    }
    #[test] #[ignore] fn worker_fixture(){
        use std::io::Write;println!("WORKER_READY");std::io::stdout().flush().unwrap();
        let mut generation=String::new();
        if std::io::stdin().read_line(&mut generation).unwrap()>0 {
            verify_current_generation(generation.trim()).unwrap();
            assert!(verify_current_generation(&uuid::Uuid::new_v4().to_string()).is_err());
            let names:Vec<_>=std::env::vars_os().map(|(k,_)|k.to_string_lossy().into_owned()).collect();
            assert_eq!(names.len(),1);assert!(names[0].eq_ignore_ascii_case("SystemRoot"));
            let _socket=std::net::TcpListener::bind("127.0.0.1:0").expect("supervised worker must initialize Winsock");
            println!("MEMBERSHIP_CONFIRMED");std::io::stdout().flush().unwrap();
        }
        std::thread::sleep(Duration::from_secs(30));
    }
    #[test] #[ignore] fn tree_fixture(){
        use std::io::{BufRead,Write};
        let fixture=format!("{}::worker_fixture",module_path!().split_once("::").unwrap().1);
        let mut child=Command::new(std::env::current_exe().unwrap()).args(["--ignored","--exact",&fixture,"--nocapture"]).stdout(std::process::Stdio::piped()).spawn().unwrap();
        let mut reader=std::io::BufReader::new(child.stdout.take().unwrap());
        loop {let mut line=String::new();assert!(reader.read_line(&mut line).unwrap()>0);if line.contains("WORKER_READY"){break;}}
        println!("WORKER_READY");std::io::stdout().flush().unwrap();std::thread::sleep(Duration::from_secs(30));
    }
    #[test] fn worker_confirms_own_generation_not_parent_job_or_command_line(){
        use std::io::{BufRead,Write};
        assert!(verify_current_generation("not-a-generation").is_err());
        assert!(verify_current_generation(&uuid::Uuid::new_v4().to_string()).is_err());
        let generation=uuid::Uuid::new_v4().to_string();
        let fixture=format!("{}::worker_fixture",module_path!().split_once("::").unwrap().1);
        let mut command=Command::new(std::env::current_exe().unwrap());command.args(["--ignored","--exact",&fixture,"--nocapture"]);
        let mut child=spawn(&command,&generation).unwrap();let mut reader=std::io::BufReader::new(child.stdout.take().unwrap());
        loop {let mut line=String::new();assert!(reader.read_line(&mut line).unwrap()>0);if line.contains("WORKER_READY"){break;}}
        writeln!(child.stdin.as_mut().unwrap(),"{generation}").unwrap();
        loop {let mut line=String::new();assert!(reader.read_line(&mut line).unwrap()>0);if line.contains("MEMBERSHIP_CONFIRMED"){break;}}
        child.kill().unwrap();wait_exit(&mut child);
    }
    #[test] fn spawn_failure_and_generation_collision_fail_closed(){
        let generation=uuid::Uuid::new_v4().to_string();
        assert!(spawn(&Command::new("Z:\\missing-companion-worker.exe"),&generation).is_err());fence_generation(&generation).unwrap();
        let mut child=worker(&generation,false);
        assert!(spawn(&Command::new(std::env::current_exe().unwrap()),&generation).is_err());
        child.kill().unwrap();wait_exit(&mut child);drop(child);fence_generation(&generation).unwrap();
    }
    #[test] fn owner_crash_kills_worker_without_pid_recovery(){
        use std::io::{BufRead,Write};
        let fixture=format!("{}::crash_fixture",module_path!().split_once("::").unwrap().1);
        let mut parent=Command::new(std::env::current_exe().unwrap()).args(["--ignored","--exact",&fixture,"--nocapture"])
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
        let mut reader=std::io::BufReader::new(parent.stdout.take().unwrap());let mut line=String::new();
        loop {line.clear();assert!(reader.read_line(&mut line).unwrap()>0);if let Some(at)=line.find("WORKER "){line=line[at..].to_string();break;}}
        let fields:Vec<_>=line.split_whitespace().collect();let generation=fields[1].to_string();let pid=fields[2].parse::<u32>().unwrap();
        // Capture the kernel handle BEFORE crashing parent; reused PID is never used for takeover.
        let process=unsafe{own(OpenProcess(PROCESS_SYNCHRONIZE,0,pid)).unwrap()};
        parent.stdin.as_mut().unwrap().write_all(b"crash\n").unwrap();assert!(!parent.wait().unwrap().success());
        assert_eq!(unsafe{WaitForSingleObject(process.as_raw_handle(),2000)},WAIT_OBJECT_0);
        fence_generation(&generation).unwrap();
    }
    #[test] #[ignore] fn crash_fixture(){
        use std::io::Write;
        let generation=uuid::Uuid::new_v4().to_string();let mut c=Command::new("C:\\Windows\\System32\\cmd.exe");c.args(["/d","/c","ping -n 30 127.0.0.1 >nul"]);
        let child=spawn(&c,&generation).unwrap();println!("WORKER {} {}",generation,child.id());std::io::stdout().flush().unwrap();
        let mut line=String::new();std::io::stdin().read_line(&mut line).unwrap();std::process::exit(7);
    }
    #[test] fn native_job_stop_and_missing_generation(){
        let generation=uuid::Uuid::new_v4().to_string();let mut child=worker(&generation,false);
        assert!(child.try_wait().unwrap().is_none());fence_generation(&generation).unwrap();
        // Recovery captured its own current witness; it does not update the old Runtime's
        // initial membership snapshot. Assert actual owned-kernel termination directly.
        assert_eq!(unsafe{WaitForSingleObject(child.process.as_raw_handle(),0)},WAIT_OBJECT_0);
        assert_eq!(accounting(child.job.as_raw_handle()).unwrap().ActiveProcesses,0);
        drop(child);fence_generation(&generation).unwrap();
    }
    #[test] fn native_descendant_tree_waits_for_kernel_handles(){
        let generation=uuid::Uuid::new_v4().to_string();let mut child=worker(&generation,true);
        child.kill().unwrap();wait_exit(&mut child);drop(child);fence_generation(&generation).unwrap();
    }
}
