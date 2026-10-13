//! Atomic job-list spawn: no runnable or suspended worker exists outside its job.
//! Only owned kernel handles / a generation-named job are termination evidence.
use std::{ffi::OsStr, fs::File, io, mem::size_of, os::windows::{ffi::OsStrExt, io::{FromRawHandle, OwnedHandle, AsRawHandle}, process::ExitStatusExt}, process::{Command, ExitStatus}, ptr, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::*, Security::SECURITY_ATTRIBUTES, System::{JobObjects::*, Pipes::CreatePipe, Threading::*, SystemServices::{JOB_OBJECT_QUERY,JOB_OBJECT_TERMINATE}}};

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

pub(super) struct Child {
    process:OwnedHandle, job:OwnedHandle, pid:u32,
    pub stdin:Option<File>,pub stdout:Option<File>,pub stderr:Option<File>,
}
impl Child {
    pub fn id(&self)->u32{self.pid}
    pub fn kill(&mut self)->io::Result<()>{unsafe {
        if TerminateJobObject(self.job.as_raw_handle(),1)==0{Err(io::Error::last_os_error())}else{Ok(())}
    }}
    pub fn try_wait(&mut self)->io::Result<Option<ExitStatus>>{unsafe {
        match WaitForSingleObject(self.process.as_raw_handle(),0) {
            WAIT_TIMEOUT=>Ok(None),WAIT_OBJECT_0=>{
                // Root exit alone is insufficient: a descendant may still own an IPC pipe.
                if active(self.job.as_raw_handle())?!=0{return Ok(None);}
                let mut code=0;if GetExitCodeProcess(self.process.as_raw_handle(),&mut code)==0{return Err(io::Error::last_os_error());}
                Ok(Some(ExitStatus::from_raw(code)))
            },_=>Err(io::Error::last_os_error()),
        }
    }}
}
fn active(job:HANDLE)->io::Result<u32>{unsafe {
    let mut info=JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    if QueryInformationJobObject(job,JobObjectBasicAccountingInformation,(&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),size_of_val(&info) as u32,ptr::null_mut())==0{return Err(io::Error::last_os_error());}Ok(info.ActiveProcesses)
}}
pub(super) fn spawn(command:&Command,generation:&str)->io::Result<Child>{unsafe {
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
    // Runtime deliberately clears environment; do not inherit account credentials.
    let env=[0u16,0];let mut pi=PROCESS_INFORMATION::default();
    if CreateProcessW(program.as_ptr(),line.as_mut_ptr(),ptr::null(),ptr::null(),1,EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,env.as_ptr().cast(),cwd.as_ref().map_or(ptr::null(),|x|x.as_ptr()),&startup.StartupInfo,&mut pi)==0{return Err(io::Error::last_os_error());}
    let process=own(pi.hProcess)?;let _thread=own(pi.hThread)?;
    Ok(Child{process,job,pid:pi.dwProcessId,stdin:Some(stdin),stdout:Some(stdout),stderr:Some(stderr)})
}}
// Explicit recovery only. Never called from normal bootstrap. No PID lookup or killing by PID.
pub(crate) fn fence_generation(generation:&str)->Result<(),String>{unsafe {
    let n=name(generation).map_err(|_|"invalid_process_generation")?;
    let raw=OpenJobObjectW(JOB_OBJECT_QUERY|JOB_OBJECT_TERMINATE,0,n.as_ptr());
    if raw.is_null(){return if GetLastError()==ERROR_FILE_NOT_FOUND {Ok(())}else{Err("process_fence_unproven".into())};}
    let job=own(raw).map_err(|_|"process_fence_unproven")?;
    if TerminateJobObject(job.as_raw_handle(),1)==0{return Err("process_fence_unproven".into());}
    let deadline=Instant::now()+Duration::from_secs(2);
    loop {if active(job.as_raw_handle()).map_err(|_|"process_fence_unproven")?==0{return Ok(());}
        if Instant::now()>=deadline{return Err("process_fence_unproven".into());}std::thread::sleep(Duration::from_millis(5));}
}}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn quoting_preserves_trailing_slashes_and_quotes(){assert_eq!(quote(OsStr::new("a\\\"b\\")).unwrap(),"\"a\\\\\\\"b\\\\\"".encode_utf16().collect::<Vec<_>>());}
    #[test] fn spawn_failure_and_generation_collision_fail_closed(){
        let generation=uuid::Uuid::new_v4().to_string();
        assert!(spawn(&Command::new("Z:\\missing-companion-worker.exe"),&generation).is_err());
        fence_generation(&generation).unwrap();
        let mut c=Command::new("C:\\Windows\\System32\\cmd.exe");c.args(["/d","/c","ping -n 30 127.0.0.1 >nul"]);
        let mut child=spawn(&c,&generation).unwrap();assert!(spawn(&c,&generation).is_err());child.kill().unwrap();
        fence_generation(&generation).unwrap();assert!(child.try_wait().unwrap().is_some());
    }
    #[test] fn owner_crash_kills_worker_without_pid_recovery(){
        use std::io::{BufRead,Write};
        let mut parent=Command::new(std::env::current_exe().unwrap()).args(["--ignored","--exact","core::plugin_runtime::windows::tests::crash_fixture","--nocapture"])
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
        let generation=uuid::Uuid::new_v4().to_string();let mut command=Command::new("C:\\Windows\\System32\\cmd.exe");command.args(["/d","/c","ping -n 30 127.0.0.1 >nul"]);
        let mut child=spawn(&command,&generation).unwrap();assert!(child.try_wait().unwrap().is_none());
        fence_generation(&generation).unwrap();assert!(child.try_wait().unwrap().is_some());drop(child);fence_generation(&generation).unwrap();
    }
}
