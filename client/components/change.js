import React from "react";

import { Button } from "./";
import { change } from "../helpers/";
import { Popup } from "./popup";
import { t } from "../locales/";
import { ChmodComponent } from "../pages/filespage/chmod";
import { ChownComponent } from "../pages/filespage/chown";

export class ModalChange extends Popup {
    constructor(props) {
        super(props);
    }

    componentDidMount() {

        change.subscribe((file, userInfo, okCallback, cancelCallback) => {
            let permissions = this.permissionsToList(file.perm);
            
            
            this.setState({
                fileInfo: file,
                appear: true,
                oldPermissions:permissions,
                newPermissions:permissions,
                userInfo:userInfo,
                fns: { ok: okCallback, cancel: cancelCallback },
            });
        });
    }

    permissionsToList(permissions){
        let perms = permissions.toString(8);
        let ret = [];
        for (let i = 0; i< 3; i++){
            let group_perms = parseInt(perms[i]);
            for (let j = 2; j>= 0; j--){
                if (group_perms >= 2**j){
                    ret.push(true);
                    group_perms -= 2**j;
                }
                else{
                    ret.push(false);
                }
            }
        }
        return ret;
    }

    permissionsToString(list){
        let ret = 0;
        for (let i = 0; i < 3; i++){
            for (let j = 0; j < 3; j++){
                if (list[i*3 + j]){
                    ret += 2**(2-j);
                }
            }
            if (i !== 2){
                ret = ret * 10;
            }
        }
        return ret.toString(10);
    }

    updateState(i){
        return function(){
            let newPermissions = this.state.newPermissions;
            newPermissions[i] = !this.state.newPermissions[i];
            this.setState({newPermissions: newPermissions})
        }
    }

    modalContentBody() {
        return (
            <div className="modal-message">
                <ChownComponent 
                    fileInfo = {this.state.fileInfo}
                    userInfo = {this.state.userInfo}  
                />
                <ChmodComponent 
                    fileInfo = {this.state.fileInfo}
                    userInfo = {this.state.userInfo} 
                    permissions={this.state.oldPermissions} 
                    onChange = { (i) => {return this.updateState(i).bind(this);} }
                />
            </div>
        );
    }

    ok() {
        if (this.state.fns && typeof this.state.fns.ok === "function") {
            let perm_string = this.permissionsToString(this.state.newPermissions);
            this.state.fns.ok(perm_string);
        }
        this.setState({ appear: false });
    }
    cancel() {
        if (this.state.fns && typeof this.state.fns.cancel === "function") {
            this.state.fns.cancel();
        }
        this.setState({ appear: false });
    }

    modalContentFooter() {
        return (
            <div>
                <Button type="button" onClick={this.cancel.bind(this)}>{ t("CANCEL") } </Button>
                <Button type="submit" theme="emphasis" onClick={this.ok.bind(this)}>
                    { t("OK") }
                </Button>
            </div>
        );
    }
}
